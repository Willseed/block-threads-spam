import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createApp } from '../index';
import type { IdentityVerifier } from '../identity/types';
import { connectionCoordinator } from '../coordinator';

function applicationFor(subject: string, recent = false) {
  const verifier: IdentityVerifier = {
    verify: () =>
      Promise.resolve({
        subject,
        ...(recent
          ? {
              authenticatedAt: new Date().toISOString(),
              sessionBinding: 'f'.repeat(64),
            }
          : {}),
      }),
  };
  return createApp({ identityVerifier: verifier });
}

async function createConnection(subject = 'idp|owner') {
  const response = await applicationFor(subject).request(
    '/api/connections',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protectedUsername: '@WillSeed' }),
    },
    env,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ connection: { id: string; protectedUsername: string } }>();
  return body.connection;
}

async function installConnectedCredential(connectionId: string) {
  const row = await env.DB.prepare('SELECT tenant_id FROM threads_connections WHERE id = ?')
    .bind(connectionId)
    .first<{ tenant_id: string }>();
  if (!row) throw new Error('Missing test connection');
  await env.DB.prepare(
    `UPDATE threads_connections
     SET status = 'connected', platform_user_id = 'owner-platform-id'
     WHERE id = ?`,
  )
    .bind(connectionId)
    .run();
  const coordinator = await connectionCoordinator(
    {
      CONNECTION_COORDINATOR: env.CONNECTION_COORDINATOR,
      COORDINATOR_NAMESPACE_KEY: 'test-only-coordinator-namespace-key-material',
    },
    row.tenant_id,
    connectionId,
  );
  const lease = await coordinator.stub.acquire({
    ownerDigest: coordinator.ownerDigest,
    revocationVersion: 0,
    jobId: 'install-test-credential',
    kind: 'connect',
    ttlSeconds: 60,
  });
  if (lease.status !== 'acquired') throw new Error('Unable to initialize test coordinator');
  await coordinator.stub.storeCredential(coordinator.ownerDigest, {
    accessToken: 'profile-lookup-token',
    tokenType: 'bearer',
    issuedAt: '2026-07-19T00:00:00.000Z',
    expiresAt: '2099-07-19T00:00:00.000Z',
    scopes: ['threads_basic', 'threads_profile_discovery'],
    identity: { platformUserId: 'owner-platform-id', username: 'willseed' },
  });
  await coordinator.stub.release(
    coordinator.ownerDigest,
    'install-test-credential',
    lease.generation,
  );
}

describe('connection and manual candidate API', () => {
  it('creates a normalized connection inside the authenticated personal tenant', async () => {
    const connection = await createConnection();

    expect(connection.protectedUsername).toBe('willseed');
    const response = await applicationFor('idp|owner').request(
      '/api/connections',
      undefined,
      env,
    );
    const body = await response.json<{ connections: { id: string }[] }>();
    expect(body.connections.map(({ id }) => id)).toContain(connection.id);
  });

  it('adds and lists one explicit candidate with an explanation', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');
    const createResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: '@Will.Seed' }),
      },
      env,
    );

    expect(createResponse.status).toBe(201);
    const listResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      undefined,
      env,
    );
    const body = await listResponse.json<{
      candidates: { username: string; reasons: string[] }[];
    }>();
    expect(body.candidates).toEqual([
      expect.objectContaining({
        username: 'will.seed',
        reasons: ['使用者人工加入完整帳號名稱'],
      }),
    ]);
  });

  it('does not expose or mutate a guessed connection from another tenant', async () => {
    const connection = await createConnection('idp|owner');
    const attacker = applicationFor('idp|attacker');

    const createResponse = await attacker.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'lookalike' }),
      },
      env,
    );
    expect(createResponse.status).toBe(404);

    const listResponse = await attacker.request(
      `/api/connections/${connection.id}/candidates`,
      undefined,
      env,
    );
    await expect(listResponse.json()).resolves.toEqual({ candidates: [] });
  });

  it('rejects malformed or duplicate candidate input', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');

    const invalid = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'bad name' }),
      },
      env,
    );
    expect(invalid.status).toBe(400);

    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lookalike' }),
    };
    expect(
      (await app.request(`/api/connections/${connection.id}/candidates`, request, env)).status,
    ).toBe(201);
    expect(
      (await app.request(`/api/connections/${connection.id}/candidates`, request, env)).status,
    ).toBe(409);
  });

  it('generates a bounded server-side candidate snapshot idempotently', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabledRules: ['punctuation'],
        totalLimit: 5,
        perRuleLimit: 5,
      }),
    };

    const first = await app.request(
      `/api/connections/${connection.id}/candidates/generate`,
      request,
      env,
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      snapshot: { generated: 5, created: 5, limits: { total: 5, perRule: 5 } },
    });

    const second = await app.request(
      `/api/connections/${connection.id}/candidates/generate`,
      request,
      env,
    );
    await expect(second.json()).resolves.toMatchObject({
      snapshot: { generated: 5, created: 0 },
    });
  });

  it('refuses to generate against another tenant connection', async () => {
    const connection = await createConnection('idp|owner');
    const response = await applicationFor('idp|attacker').request(
      `/api/connections/${connection.id}/candidates/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      env,
    );

    expect(response.status).toBe(404);
  });

  it('refreshes one candidate through its credential-owning coordinator', async () => {
    const connection = await createConnection();
    await installConnectedCredential(connection.id);
    const app = applicationFor('idp|owner');
    const createResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'will.seed' }),
      },
      env,
    );
    const candidate = (await createResponse.json<{ candidate: { id: string } }>()).candidate;

    const response = await app.request(
      `/api/connections/${connection.id}/candidates/${candidate.id}/refresh`,
      { method: 'POST' },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json<{
      lookup: unknown;
      candidate: { status: string; priority: string };
    }>();
    expect(body).toMatchObject({
      lookup: {
        status: 'found',
        profile: { username: 'will.seed', displayName: 'Will Seed' },
      },
      candidate: { status: 'pending_review', priority: 'medium' },
    });
    expect(JSON.stringify(body)).not.toContain('profile-lookup-token');
  });

  it('revokes active credentials while retaining review records when requested', async () => {
    const connection = await createConnection();
    await installConnectedCredential(connection.id);
    const app = applicationFor('idp|owner', true);
    const candidateResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'will.seed' }),
      },
      env,
    );
    expect(candidateResponse.status).toBe(201);

    const response = await app.request(
      `/api/connections/${connection.id}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataRetention: 'retain' }),
      },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connection: { status: 'revoked', revocationVersion: 1 },
    });
    const candidates = await app.request(
      `/api/connections/${connection.id}/candidates`,
      undefined,
      env,
    );
    await expect(candidates.json()).resolves.toMatchObject({ candidates: [{ username: 'will.seed' }] });

    const tenant = await env.DB.prepare('SELECT tenant_id FROM threads_connections WHERE id = ?')
      .bind(connection.id)
      .first<{ tenant_id: string }>();
    if (!tenant) throw new Error('Missing test tenant');
    const coordinator = await connectionCoordinator(
      {
        CONNECTION_COORDINATOR: env.CONNECTION_COORDINATOR,
        COORDINATOR_NAMESPACE_KEY: 'test-only-coordinator-namespace-key-material',
      },
      tenant.tenant_id,
      connection.id,
    );
    await expect(coordinator.stub.credentialStatus(coordinator.ownerDigest)).resolves.toEqual({
      connected: false,
    });
    await expect(coordinator.stub.status(coordinator.ownerDigest)).resolves.toMatchObject({
      revoked: true,
      revocationVersion: 1,
    });
  });

  it('deletes candidate records when revocation explicitly requests deletion', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner', true);
    await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'will.seed' }),
      },
      env,
    );

    const response = await app.request(
      `/api/connections/${connection.id}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataRetention: 'delete' }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM candidates WHERE connection_id = ?',
    )
      .bind(connection.id)
      .first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it('applies one audited candidate decision through valid state transitions', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');
    const createResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'will.seed' }),
      },
      env,
    );
    const candidate = (await createResponse.json<{ candidate: { id: string } }>()).candidate;
    await env.DB.prepare("UPDATE candidates SET status = 'pending_review' WHERE id = ?")
      .bind(candidate.id)
      .run();

    for (const [action, status] of [
      ['watch', 'watching'],
      ['ignore', 'ignored'],
      ['resume', 'watching'],
    ] as const) {
      const response = await app.request(
        `/api/connections/${connection.id}/candidates/${candidate.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        },
        env,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ candidate: { status } });
    }
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'candidate.decision'",
    ).first<{ count: number }>();
    expect(audits?.count).toBe(3);
  });

  it('rejects a candidate decision that is not valid in the current state', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');
    const createResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'will.seed' }),
      },
      env,
    );
    const candidate = (await createResponse.json<{ candidate: { id: string } }>()).candidate;

    const response = await app.request(
      `/api/connections/${connection.id}/candidates/${candidate.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'ignore' }),
      },
      env,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_candidate_state' },
    });
  });

  it('issues one short-lived approval bound to the current evidence and session', async () => {
    const connection = await createConnection();
    await installConnectedCredential(connection.id);
    const app = applicationFor('idp|owner', true);
    const createResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'will.seed' }),
      },
      env,
    );
    const candidate = (await createResponse.json<{ candidate: { id: string } }>()).candidate;
    const refresh = await app.request(
      `/api/connections/${connection.id}/candidates/${candidate.id}/refresh`,
      { method: 'POST' },
      env,
    );
    expect(refresh.status).toBe(200);

    const response = await app.request(
      `/api/connections/${connection.id}/candidates/${candidate.id}/approvals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exactTargetUsername: '@Will.Seed' }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json<{
      approval: { id: string; exactTargetUsername: string; evidenceVersion: string };
      actionToken: string;
    }>();
    expect(body.approval.exactTargetUsername).toBe('will.seed');
    expect(body.approval.evidenceVersion).toMatch(/^snp_/);
    expect(body.actionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await env.DB.prepare(
      `SELECT nonce_hash, session_binding, status FROM approvals WHERE id = ?`,
    )
      .bind(body.approval.id)
      .first<{ nonce_hash: string; session_binding: string; status: string }>();
    expect(stored).toMatchObject({ session_binding: 'f'.repeat(64), status: 'issued' });
    expect(stored?.nonce_hash).not.toBe(body.actionToken);

    const repeated = await app.request(
      `/api/connections/${connection.id}/candidates/${candidate.id}/approvals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exactTargetUsername: 'will.seed' }),
      },
      env,
    );
    expect(repeated.status).toBe(409);
  });

  it('keeps low-frequency schedules off until an owned connection is confirmed', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');
    const initial = await app.request(
      `/api/connections/${connection.id}/schedule`,
      undefined,
      env,
    );
    await expect(initial.json()).resolves.toEqual({
      schedule: { enabled: false, timezone: 'UTC', frequencyPolicy: 'daily_low_frequency' },
    });

    const enableRequest = {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, timezone: 'Asia/Taipei' }),
    };
    const unconfirmed = await app.request(
      `/api/connections/${connection.id}/schedule`,
      enableRequest,
      env,
    );
    expect(unconfirmed.status).toBe(409);

    await env.DB.prepare("UPDATE threads_connections SET status = 'connected' WHERE id = ?")
      .bind(connection.id)
      .run();
    const enabled = await app.request(
      `/api/connections/${connection.id}/schedule`,
      enableRequest,
      env,
    );
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      schedule: {
        enabled: true,
        timezone: 'Asia/Taipei',
        frequencyPolicy: 'daily_low_frequency',
      },
    });
  });

  it('rejects invalid schedule timezones', async () => {
    const connection = await createConnection();
    const response = await applicationFor('idp|owner').request(
      `/api/connections/${connection.id}/schedule`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, timezone: 'Not/A_Timezone' }),
      },
      env,
    );
    expect(response.status).toBe(400);
  });
});
