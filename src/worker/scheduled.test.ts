import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { D1Repository } from '../platform/d1/repository';
import { connectionCoordinator } from './coordinator';
import type { AppBindings } from './environment';
import { runScheduledScans } from './scheduled';

function bindings(): AppBindings {
  return {
    DB: env.DB,
    EVIDENCE: env.EVIDENCE,
    CONNECTION_COORDINATOR: env.CONNECTION_COORDINATOR,
    COORDINATOR_NAMESPACE_KEY: 'test-only-coordinator-namespace-key-material',
    SESSION_ENCRYPTION_KEY: 'ERERERERERERERERERERERERERERERERERERERERERE',
    META_GRAPH_API_VERSION: 'v1.0',
    FEATURE_META_PROFILE_LOOKUP: 'true',
  };
}

describe('scheduled candidate scans', () => {
  it('claims bounded due work and refreshes one non-destructive candidate', async () => {
    const applicationRepository = new D1Repository(env.DB);
    const tenant = await applicationRepository.ensurePersonalTenant({ subject: 'scheduler-owner' });
    const connection = await applicationRepository.createConnection(
      tenant,
      'protected.owner',
      'meta_oauth',
    );
    const candidate = await applicationRepository.addCandidate(tenant, connection.id, {
      username: 'target.account',
      sourceType: 'manual',
      sourceRules: [],
      reasons: ['test target'],
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE threads_connections SET status = 'connected', platform_user_id = 'owner-id' WHERE id = ?",
      ).bind(connection.id),
      env.DB.prepare("UPDATE candidates SET status = 'watching' WHERE id = ?").bind(candidate.id),
      env.DB.prepare(
        `INSERT INTO schedule_preferences
           (connection_id, enabled, timezone, frequency_policy, next_run_at)
         VALUES (?, 1, 'Asia/Taipei', 'daily_low_frequency', ?)`,
      ).bind(connection.id, new Date(Date.now() - 60_000).toISOString()),
    ]);
    const coordinator = await connectionCoordinator(
      bindings(),
      tenant.tenantId,
      connection.id,
    );
    const lease = await coordinator.stub.acquire({
      ownerDigest: coordinator.ownerDigest,
      revocationVersion: 0,
      jobId: 'install-scheduled-credential',
      kind: 'connect',
      ttlSeconds: 60,
    });
    if (lease.status !== 'acquired') throw new Error('Unable to initialize scheduler fixture');
    await coordinator.stub.storeCredential(coordinator.ownerDigest, {
      accessToken: 'scheduled-profile-token',
      tokenType: 'bearer',
      issuedAt: '2026-07-19T00:00:00.000Z',
      expiresAt: '2099-07-19T00:00:00.000Z',
      scopes: ['threads_basic', 'threads_profile_discovery'],
      identity: { platformUserId: 'owner-id', username: 'protected.owner' },
    });
    await coordinator.stub.release(
      coordinator.ownerDigest,
      'install-scheduled-credential',
      lease.generation,
    );

    await expect(runScheduledScans(bindings())).resolves.toBe(1);

    const updated = await applicationRepository.getCandidate(tenant, connection.id, candidate.id);
    expect(updated).toMatchObject({ status: 'pending_review', targetPlatformId: 'platform-target.account' });
    const schedule = await env.DB.prepare(
      'SELECT last_run_at, next_run_at, lease_until FROM schedule_preferences WHERE connection_id = ?',
    )
      .bind(connection.id)
      .first<{ last_run_at: string; next_run_at: string; lease_until: string | null }>();
    expect(schedule?.last_run_at).toBeTruthy();
    expect(schedule?.lease_until).toBeNull();
    const approvals = await env.DB.prepare('SELECT COUNT(*) AS count FROM approvals').first<{
      count: number;
    }>();
    expect(approvals?.count).toBe(0);
  });

  it('does no work when official profile lookup is disabled', async () => {
    await expect(
      runScheduledScans({ ...bindings(), FEATURE_META_PROFILE_LOOKUP: 'false' }),
    ).resolves.toBe(0);
  });
});
