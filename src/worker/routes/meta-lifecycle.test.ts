import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { D1Repository } from '../../platform/d1/repository';
import { R2EvidenceRepository } from '../../platform/r2/evidence-repository';
import { createApp } from '../index';

const APP_ID = 'test-meta-app-id';
const APP_SECRET = 'test-meta-app-secret';
const PLATFORM_USER_ID = '17841400000000001';
const encoder = new TextEncoder();

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function signedRequest(userId: string, issuedAt: number, secret = APP_SECRET) {
  const payload = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        algorithm: 'HMAC-SHA256',
        user_id: userId,
        issued_at: issuedAt,
        app_id: APP_ID,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${encodeBase64Url(new Uint8Array(signature))}.${payload}`;
}

async function callback(path: string, value: string) {
  return createApp().request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ signed_request: value }).toString(),
    },
    env,
  );
}

async function connectedFixture(
  subject: string,
  username: string,
  platformUserId: string,
  lastVerifiedAt: Date,
) {
  const d1 = new D1Repository(env.DB);
  const tenant = await d1.ensurePersonalTenant({ subject });
  const connection = await d1.createConnection(tenant, username, 'meta_oauth');
  await env.DB.prepare(
    `UPDATE threads_connections
     SET status = 'connected', platform_user_id = ?, last_verified_at = ?
     WHERE id = ?`,
  )
    .bind(platformUserId, lastVerifiedAt.toISOString(), connection.id)
    .run();
  return { tenant, connection };
}

async function evidenceFixture(
  fixture: Awaited<ReturnType<typeof connectedFixture>>,
  suffix: string,
) {
  const repository = new R2EvidenceRepository(env.DB, env.EVIDENCE, {
    idFactory: (() => {
      const ids = [`record-${suffix}`, `object-${suffix}`, `audit-${suffix}`];
      return () => ids.shift() ?? crypto.randomUUID();
    })(),
  });
  const evidence = await repository.put(fixture.tenant, {
    connectionId: fixture.connection.id,
    evidenceType: 'diagnostic',
    source: 'fixture',
    contentType: 'text/plain',
    body: encoder.encode(`private-${suffix}`),
    retentionUntil: new Date(Date.now() + 86_400_000),
  });
  const row = await env.DB.prepare('SELECT r2_key FROM evidence_objects WHERE id = ?')
    .bind(evidence.id)
    .first<{ r2_key: string }>();
  if (!row) throw new Error('Missing evidence fixture');
  return row.r2_key;
}

describe('Meta lifecycle callbacks', () => {
  it('deletes every old matching connection without deleting a later reauthorization', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const oldVerifiedAt = new Date((issuedAt - 60) * 1000);
    const oldA = await connectedFixture(
      'idp|meta-owner-a',
      'meta.owner.a',
      PLATFORM_USER_ID,
      oldVerifiedAt,
    );
    const oldB = await connectedFixture(
      'idp|meta-owner-b',
      'meta.owner.b',
      PLATFORM_USER_ID,
      oldVerifiedAt,
    );
    const newer = await connectedFixture(
      'idp|meta-owner-new',
      'meta.owner.new',
      PLATFORM_USER_ID,
      new Date((issuedAt + 60) * 1000),
    );
    const oldObjectKeys = await Promise.all([
      evidenceFixture(oldA, 'a'),
      evidenceFixture(oldB, 'b'),
    ]);
    const value = await signedRequest(PLATFORM_USER_ID, issuedAt);

    const response = await callback('/meta/threads/data-deletion', value);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json<{ url: string; confirmation_code: string }>();
    expect(body.confirmation_code).toMatch(/^[a-f0-9]{64}$/u);
    expect(body.url).toBe(
      `https://guard.example/meta/threads/data-deletion/status/${body.confirmation_code}`,
    );

    const remaining = await env.DB.prepare(
      'SELECT id FROM threads_connections ORDER BY id',
    ).all<{ id: string }>();
    expect(remaining.results.map(({ id }) => id)).toEqual([newer.connection.id]);
    const principals = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM tenants) AS tenants,
         (SELECT COUNT(*) FROM memberships) AS memberships`,
    ).first<{ users: number; tenants: number; memberships: number }>();
    expect(principals).toEqual({ users: 3, tenants: 3, memberships: 3 });
    for (const key of oldObjectKeys) {
      await expect(env.EVIDENCE.get(key)).resolves.toBeNull();
    }
    const oldAudits = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM audit_events WHERE connection_id IN (?, ?)',
    )
      .bind(oldA.connection.id, oldB.connection.id)
      .first<{ count: number }>();
    expect(oldAudits?.count).toBe(0);

    const receipt = await env.DB.prepare(
      `SELECT status, platform_user_id
       FROM meta_lifecycle_requests WHERE kind = 'data_deletion'`,
    ).first<{ status: string; platform_user_id: string | null }>();
    expect(receipt).toEqual({ status: 'completed', platform_user_id: null });

    const status = await createApp().request(
      `/meta/threads/data-deletion/status/${body.confirmation_code}`,
      { headers: { 'cf-connecting-ip': '203.0.113.10' } },
      env,
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({ status: 'completed' });

    const replay = await callback('/meta/threads/data-deletion', value);
    await expect(replay.json()).resolves.toMatchObject({
      confirmation_code: body.confirmation_code,
    });
    const receiptCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM meta_lifecycle_requests WHERE kind = 'data_deletion'",
    ).first<{ count: number }>();
    expect(receiptCount?.count).toBe(1);

    const deauthorize = await callback('/meta/threads/deauthorize', value);
    expect(deauthorize.status).toBe(200);
    const kinds = await env.DB.prepare(
      'SELECT kind FROM meta_lifecycle_requests ORDER BY kind',
    ).all<{ kind: string }>();
    expect(kinds.results.map(({ kind }) => kind)).toEqual([
      'data_deletion',
      'deauthorize',
    ]);
  });

  it('rejects forged callbacks while leaving the public status response opaque', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const forged = await signedRequest(PLATFORM_USER_ID, issuedAt, 'wrong-app-secret');

    const response = await callback('/meta/threads/data-deletion', forged);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_meta_callback' },
    });
    const rateLimitRows = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM rate_limit_windows',
    ).first<{ count: number }>();
    expect(rateLimitRows?.count).toBe(0);
    const missing = await createApp().request(
      `/meta/threads/data-deletion/status/${'a'.repeat(64)}`,
      { headers: { 'cf-connecting-ip': '203.0.113.11' } },
      env,
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: { code: 'not_found', message: '找不到資料刪除要求。' },
    });
  });

  it('bounds replay work only after a callback signature is valid', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const value = await signedRequest(PLATFORM_USER_ID, issuedAt);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await callback('/meta/threads/deauthorize', value);
      expect(response.status).toBe(200);
    }
    const limited = await callback('/meta/threads/deauthorize', value);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: 'rate_limited' },
    });
  });

  it('does not weaken Access protection for API and OAuth routes', async () => {
    const application = createApp();

    await expect(application.request('/api/me', undefined, env)).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      application.request('/auth/threads/callback', undefined, env),
    ).resolves.toMatchObject({ status: 401 });
  });
});
