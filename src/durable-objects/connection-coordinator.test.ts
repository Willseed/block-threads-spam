import { env } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const OWNER = 'a'.repeat(64);
const CREDENTIAL = {
  accessToken: 'long-lived-secret-token',
  tokenType: 'bearer' as const,
  issuedAt: '2026-07-19T00:00:00.000Z',
  expiresAt: '2026-09-17T00:00:00.000Z',
  scopes: ['threads_basic', 'threads_profile_discovery'] as const,
  identity: {
    platformUserId: '123456789',
    username: 'official.account',
  },
};

function coordinator(name = crypto.randomUUID()) {
  const id = env.CONNECTION_COORDINATOR.idFromName(name);
  return env.CONNECTION_COORDINATOR.get(id);
}

describe('ConnectionCoordinator', () => {
  it('serializes competing jobs and makes the same job idempotent', async () => {
    const stub = coordinator();
    const first = await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'scan-1',
      kind: 'scan',
      ttlSeconds: 60,
    });
    const repeated = await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'scan-1',
      kind: 'scan',
      ttlSeconds: 60,
    });
    const competing = await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'block-1',
      kind: 'manual_block',
      ttlSeconds: 60,
    });

    expect(first).toMatchObject({ status: 'acquired', generation: 1, idempotent: false });
    expect(repeated).toMatchObject({ status: 'acquired', generation: 1, idempotent: true });
    expect(competing).toMatchObject({ status: 'busy', activeKind: 'scan' });
  });

  it('allows exactly one winner when jobs arrive concurrently', async () => {
    const stub = coordinator();
    const results = await Promise.all(
      ['job-a', 'job-b'].map((jobId) =>
        stub.acquire({
          ownerDigest: OWNER,
          revocationVersion: 0,
          jobId,
          kind: 'candidate_refresh',
          ttlSeconds: 60,
        }),
      ),
    );

    expect(results.filter(({ status }) => status === 'acquired')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'busy')).toHaveLength(1);
  });

  it('rejects stale releases and advances the generation', async () => {
    const stub = coordinator();
    await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'job-a',
      kind: 'scan',
      ttlSeconds: 60,
    });

    await expect(stub.release(OWNER, 'job-a', 99)).resolves.toBe(false);
    await expect(stub.release(OWNER, 'job-a', 1)).resolves.toBe(true);
    await expect(
      stub.acquire({
        ownerDigest: OWNER,
        revocationVersion: 0,
        jobId: 'job-b',
        kind: 'scan',
        ttlSeconds: 60,
      }),
    ).resolves.toMatchObject({ status: 'acquired', generation: 2 });
  });

  it('persists lease state across Durable Object eviction', async () => {
    const stub = coordinator();
    await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'persistent-job',
      kind: 'scan',
      ttlSeconds: 60,
    });

    await evictDurableObject(stub);

    await expect(stub.status(OWNER)).resolves.toMatchObject({
      revoked: false,
      lease: { kind: 'scan', generation: 1 },
    });
  });

  it('revokes the connection and invalidates all older work', async () => {
    const stub = coordinator();
    await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'scan-before-revoke',
      kind: 'scan',
      ttlSeconds: 60,
    });

    await expect(stub.revoke(OWNER, 0)).resolves.toBe(1);
    await expect(
      stub.acquire({
        ownerDigest: OWNER,
        revocationVersion: 0,
        jobId: 'scan-after-revoke',
        kind: 'scan',
        ttlSeconds: 60,
      }),
    ).resolves.toEqual({ status: 'revoked', revocationVersion: 1 });
    await expect(stub.status(OWNER)).resolves.toEqual({
      revocationVersion: 1,
      revoked: true,
    });
  });

  it('never shares a coordinator with a different owner digest', async () => {
    const stub = coordinator();
    await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'owner-job',
      kind: 'scan',
      ttlSeconds: 60,
    });

    await expect(stub.status('b'.repeat(64))).resolves.toBeUndefined();
  });

  it('stores only non-secret credential metadata through its RPC surface', async () => {
    const stub = coordinator();
    await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'connect-vault',
      kind: 'connect',
      ttlSeconds: 60,
    });

    await expect(stub.storeCredential(OWNER, CREDENTIAL)).resolves.toEqual({
      connected: true,
      platformUserId: '123456789',
      username: 'official.account',
      expiresAt: CREDENTIAL.expiresAt,
    });
    await expect(stub.credentialStatus(OWNER)).resolves.toMatchObject({
      connected: true,
      username: 'official.account',
    });
    await expect(stub.credentialStatus('b'.repeat(64))).resolves.toBeUndefined();
  });

  it('cryptographically deletes the credential on clear and revoke', async () => {
    const stub = coordinator();
    await stub.acquire({
      ownerDigest: OWNER,
      revocationVersion: 0,
      jobId: 'connect-delete',
      kind: 'connect',
      ttlSeconds: 60,
    });
    await stub.storeCredential(OWNER, CREDENTIAL);

    await expect(stub.clearCredential(OWNER)).resolves.toBe(true);
    await expect(stub.credentialStatus(OWNER)).resolves.toEqual({ connected: false });
    await stub.storeCredential(OWNER, CREDENTIAL);
    await expect(stub.revoke(OWNER, 0)).resolves.toBe(1);
    await expect(stub.credentialStatus(OWNER)).resolves.toEqual({ connected: false });
  });
});
