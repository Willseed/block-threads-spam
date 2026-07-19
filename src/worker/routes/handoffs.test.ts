import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserHandoffProvider } from '../../adapters/browser-handoff/types';
import { createApp } from '../index';
import type { IdentityVerifier } from '../identity/types';

const SESSION_BINDING = 'f'.repeat(64);
const ACTION_TOKEN = 'A'.repeat(43);

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function identityVerifier(): IdentityVerifier {
  return {
    verify: () =>
      Promise.resolve({
        subject: 'idp|handoff-owner',
        authenticatedAt: new Date().toISOString(),
        sessionBinding: SESSION_BINDING,
      }),
  };
}

async function approvalFixture(app: ReturnType<typeof createApp>) {
  const response = await app.request(
    '/api/connections',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protectedUsername: 'protected.owner' }),
    },
    env,
  );
  const connection = (await response.json<{ connection: { id: string } }>()).connection;
  const owner = await env.DB.prepare(
    `SELECT threads_connections.tenant_id, memberships.user_id
     FROM threads_connections
     JOIN memberships ON memberships.tenant_id = threads_connections.tenant_id
     WHERE threads_connections.id = ? AND memberships.role = 'owner'`,
  )
    .bind(connection.id)
    .first<{ tenant_id: string; user_id: string }>();
  if (!owner) throw new Error('Missing handoff owner fixture');
  const candidateId = `can_${crypto.randomUUID()}`;
  const snapshotId = `snp_${crypto.randomUUID()}`;
  const approvalId = `apr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE threads_connections
       SET status = 'connected', platform_user_id = 'protected-platform-id'
       WHERE id = ?`,
    ).bind(connection.id),
    env.DB.prepare(
      `INSERT INTO candidates
         (id, tenant_id, connection_id, username, normalized_username, source_type,
          source_rules_json, reasons_json, status, priority, first_seen_at)
       VALUES (?, ?, ?, 'target.account', 'target.account', 'manual', '[]', '[]',
               'preparing_block', 'high', ?)`,
    ).bind(candidateId, owner.tenant_id, connection.id, now),
    env.DB.prepare(
      `INSERT INTO candidate_snapshots
         (id, candidate_id, source, platform_id, username, similarity_reasons_json, checked_at)
       VALUES (?, ?, 'fixture', 'target-platform-id', 'target.account', '[]', ?)`,
    ).bind(snapshotId, candidateId, now),
    env.DB.prepare('UPDATE candidates SET current_snapshot_id = ?, last_checked_at = ? WHERE id = ?')
      .bind(snapshotId, now, candidateId),
    env.DB.prepare(
      `INSERT INTO approvals
         (id, tenant_id, user_id, connection_id, candidate_id, exact_target_username,
          target_platform_id, evidence_version, nonce_hash, status, issued_at, expires_at,
          session_binding)
       VALUES (?, ?, ?, ?, ?, 'target.account', 'target-platform-id', ?, ?, 'issued', ?, ?, ?)`,
    ).bind(
      approvalId,
      owner.tenant_id,
      owner.user_id,
      connection.id,
      candidateId,
      snapshotId,
      await sha256(ACTION_TOKEN),
      now,
      expiresAt,
      SESSION_BINDING,
    ),
  ]);
  return { approvalId };
}

describe('browser handoff broker', () => {
  it('keeps Live View capability out of JSON and issues it through one POST redirect', async () => {
    const prepare = vi.fn().mockResolvedValue({
      browserSessionId: 'browser-session-secret',
      targetId: 'target-id',
    });
    const liveViewUrl = vi.fn().mockResolvedValue(
      'https://live.browser.run/session-capability?token=short-lived-secret',
    );
    const provider: BrowserHandoffProvider = {
      isAvailable: () => true,
      prepare,
      liveViewUrl,
      close: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp({
      identityVerifier: identityVerifier(),
      browserHandoffProvider: provider,
    });
    const { approvalId } = await approvalFixture(app);

    const created = await app.request(
      '/api/handoffs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvalId, actionToken: ACTION_TOKEN }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const createdText = await created.clone().text();
    expect(createdText).not.toContain('live.browser.run');
    expect(createdText).not.toContain('browser-session-secret');
    expect(createdText).not.toContain('short-lived-secret');
    const body = JSON.parse(createdText) as { handoff: { id: string; enterPath: string } };
    const setCookie = created.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0];
    expect(cookie).toMatch(/^__Host-handoff_exchange=/);

    const entered = await app.request(
      body.handoff.enterPath,
      {
        method: 'POST',
        headers: { origin: 'https://guard.example', cookie },
      },
      env,
    );
    expect(entered.status).toBe(303);
    expect(entered.headers.get('location')).toBe(
      'https://live.browser.run/session-capability?token=short-lived-secret&mode=tab',
    );
    expect(entered.headers.get('referrer-policy')).toBe('no-referrer');
    expect(prepare).toHaveBeenCalledOnce();
    expect(liveViewUrl).toHaveBeenCalledOnce();

    const replay = await app.request(
      body.handoff.enterPath,
      {
        method: 'POST',
        headers: { origin: 'https://guard.example', cookie },
      },
      env,
    );
    expect(replay.status).toBe(409);
  });

  it('does not consume an approval when production capability is unavailable', async () => {
    const app = createApp({ identityVerifier: identityVerifier() });
    const { approvalId } = await approvalFixture(app);
    const response = await app.request(
      '/api/handoffs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvalId, actionToken: ACTION_TOKEN }),
      },
      env,
    );
    expect(response.status).toBe(503);
    const approval = await env.DB.prepare('SELECT status FROM approvals WHERE id = ?')
      .bind(approvalId)
      .first<{ status: string }>();
    expect(approval?.status).toBe('issued');
  });
});
