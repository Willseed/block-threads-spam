import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  MetaLifecycleRepository,
  type MetaLifecycleConnection,
  type NewMetaLifecycleRequest,
} from './meta-lifecycle-repository';

const PLATFORM_USER_ID = '17841400000000001';
const OTHER_PLATFORM_USER_ID = '17841400000000002';
const ISSUED_AT = Date.parse('2026-07-20T06:00:00.000Z') / 1000;
const REQUESTED_AT = '2026-07-20T06:00:00.000Z';
const EXPIRES_AT = '2026-08-19T06:00:00.000Z';
const PLATFORM_SUBJECT_DIGEST = 'a'.repeat(64);

function requestInput(
  overrides: Partial<NewMetaLifecycleRequest> = {},
): NewMetaLifecycleRequest {
  return {
    id: 'mlr_request',
    requestDigest: 'request-digest',
    kind: 'data_deletion',
    platformUserId: PLATFORM_USER_ID,
    platformSubjectDigest: PLATFORM_SUBJECT_DIGEST,
    issuedAt: ISSUED_AT,
    confirmationCodeHash: 'confirmation-code-hash',
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function tokenFactory(...tokens: string[]): () => string {
  const queue = [...tokens];
  return () => queue.shift() ?? crypto.randomUUID();
}

async function insertTenant(tenantId: string, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO users (id, identity_subject, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(userId, `identity|${userId}`, REQUESTED_AT),
    env.DB
      .prepare(
        `INSERT INTO tenants (id, owner_user_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(tenantId, userId, REQUESTED_AT),
    env.DB
      .prepare(
        `INSERT INTO memberships (tenant_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .bind(tenantId, userId, REQUESTED_AT),
  ]);
}

interface ConnectionFixture {
  id: string;
  tenantId: string;
  platformUserId?: string;
  connectionMode?: 'meta_oauth' | 'manual_handoff';
  status?: 'connected' | 'revoking';
  lastVerifiedAt?: string;
  oauthGrantedAt?: number;
  createdAt?: string;
}

async function insertConnection(input: ConnectionFixture): Promise<MetaLifecycleConnection> {
  await env.DB
    .prepare(
      `INSERT INTO threads_connections
         (id, tenant_id, protected_username, platform_user_id, connection_mode, status,
          revocation_version, last_verified_at, oauth_granted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.tenantId,
      `protected_${input.id}`,
      input.platformUserId ?? PLATFORM_USER_ID,
      input.connectionMode ?? 'meta_oauth',
      input.status ?? 'connected',
      input.lastVerifiedAt ?? '2026-07-20T05:59:00.000Z',
      input.oauthGrantedAt ?? null,
      input.createdAt ?? '2026-07-20T05:00:00.000Z',
    )
    .run();
  return { id: input.id, tenantId: input.tenantId, revocationVersion: 0 };
}

async function insertEvidence(
  id: string,
  tenantId: string,
  connectionId: string,
  createdAt: string,
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO evidence_objects
         (id, tenant_id, connection_id, evidence_type, r2_key, sha256, content_type,
          byte_length, source, created_at, retention_until)
       VALUES (?, ?, ?, 'profile_snapshot', ?, ?, 'image/png', 10, 'fixture', ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      connectionId,
      `evidence/${id}`,
      `sha256-${id}`,
      createdAt,
      EXPIRES_AT,
    )
    .run();
}

async function insertJob(id: string, tenantId: string, connectionId: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO jobs
         (id, tenant_id, connection_id, job_type, scope_hash, status, phase,
          idempotency_key_hash, created_at)
       VALUES (?, ?, ?, 'revoke', ?, 'stopped', 'stopped', ?, ?)`,
    )
    .bind(id, tenantId, connectionId, `scope-${id}`, `idempotency-${id}`, REQUESTED_AT)
    .run();
}

async function insertAudit(
  id: string,
  tenantId: string,
  connectionId: string | null,
  jobId: string | null,
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO audit_events
         (id, tenant_id, connection_id, job_id, event_type, metadata_json, created_at)
       VALUES (?, ?, ?, ?, 'fixture.event', '{}', ?)`,
    )
    .bind(id, tenantId, connectionId, jobId, REQUESTED_AT)
    .run();
}

describe('Meta lifecycle migration invariants', () => {
  it('rejects processing and completed rows that retain inconsistent identity or lease state', async () => {
    const insert = (
      id: string,
      status: 'processing' | 'completed',
      platformUserId: string | null,
      leaseUntil: string | null,
      leaseToken: string | null,
      completedAt: string | null,
    ) =>
      env.DB
        .prepare(
          `INSERT INTO meta_lifecycle_requests
             (id, request_digest, kind, platform_user_id, platform_subject_digest,
              issued_at, status,
              next_attempt_at, lease_until, lease_token, requested_at, updated_at,
              completed_at, expires_at)
           VALUES (?, ?, 'deauthorize', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          `digest-${id}`,
          platformUserId,
          PLATFORM_SUBJECT_DIGEST,
          ISSUED_AT,
          status,
          REQUESTED_AT,
          leaseUntil,
          leaseToken,
          REQUESTED_AT,
          REQUESTED_AT,
          completedAt,
          EXPIRES_AT,
        )
        .run();

    await expect(
      insert('processing-without-owner', 'processing', PLATFORM_USER_ID, REQUESTED_AT, null, null),
    ).rejects.toThrow();
    await expect(
      insert(
        'completed-with-identity',
        'completed',
        PLATFORM_USER_ID,
        null,
        null,
        REQUESTED_AT,
      ),
    ).rejects.toThrow();
    await expect(
      insert('completed-with-lease', 'completed', null, REQUESTED_AT, 'lease', REQUESTED_AT),
    ).rejects.toThrow();
  });
});

describe('MetaLifecycleRepository request receipts and leases', () => {
  it('deduplicates callbacks and completes a receipt without retaining platform identity', async () => {
    let now = new Date(REQUESTED_AT);
    const repository = new MetaLifecycleRepository(env.DB, {
      now: () => now,
      leaseTokenFactory: tokenFactory('lease-owner'),
    });
    const input = requestInput();

    await expect(repository.createOrGetRequest(input)).resolves.toMatchObject({
      id: input.id,
      status: 'pending',
      platformUserId: PLATFORM_USER_ID,
      attemptCount: 0,
    });
    await expect(
      repository.createOrGetRequest({ ...input, id: 'ignored-duplicate-id' }),
    ).resolves.toMatchObject({ id: input.id, status: 'pending' });
    await expect(
      repository.createOrGetRequest({ ...input, issuedAt: input.issuedAt + 1 }),
    ).rejects.toThrow('could not be persisted');
    await expect(
      repository.createOrGetRequest({ ...input, platformSubjectDigest: 'b'.repeat(64) }),
    ).rejects.toThrow('could not be persisted');
    await expect(
      repository.createOrGetRequest({ ...input, confirmationCodeHash: 'different-hash' }),
    ).rejects.toThrow('could not be persisted');

    await expect(repository.statusByConfirmationHash('confirmation-code-hash')).resolves.toBe(
      'pending',
    );
    const claim = await repository.claimRequest(input.requestDigest);
    expect(claim).toMatchObject({
      status: 'processing',
      leaseToken: 'lease-owner',
      platformUserId: PLATFORM_USER_ID,
      attemptCount: 1,
    });
    if (!claim) throw new Error('Expected lifecycle claim');

    await expect(repository.completeRequest(input.requestDigest, 'wrong-owner')).resolves.toBe(
      false,
    );
    await expect(
      repository.completeRequest(input.requestDigest, claim.leaseToken),
    ).resolves.toBe(true);
    await expect(
      repository.completeRequest(input.requestDigest, claim.leaseToken),
    ).resolves.toBe(true);

    const completed = await env.DB
      .prepare(
        `SELECT status, platform_user_id, platform_subject_digest,
                lease_until, lease_token, completed_at
         FROM meta_lifecycle_requests WHERE request_digest = ?`,
      )
      .bind(input.requestDigest)
      .first<{
        status: string;
        platform_user_id: string | null;
        platform_subject_digest: string;
        lease_until: string | null;
        lease_token: string | null;
        completed_at: string | null;
      }>();
    expect(completed).toEqual({
      status: 'completed',
      platform_user_id: null,
      platform_subject_digest: PLATFORM_SUBJECT_DIGEST,
      lease_until: null,
      lease_token: null,
      completed_at: REQUESTED_AT,
    });
    await expect(repository.createOrGetRequest(input)).resolves.not.toHaveProperty(
      'platformUserId',
    );
    await expect(repository.statusByConfirmationHash('confirmation-code-hash')).resolves.toBe(
      'completed',
    );

    now = new Date(EXPIRES_AT);
    await expect(repository.statusByConfirmationHash('confirmation-code-hash')).resolves.toBe(
      undefined,
    );
    await expect(repository.purgeExpiredReceipts()).resolves.toBe(1);
  });

  it('allows lease-expiry recovery while rejecting stale completion and defer attempts', async () => {
    let now = new Date(REQUESTED_AT);
    const repository = new MetaLifecycleRepository(env.DB, {
      now: () => now,
      leaseTokenFactory: tokenFactory('lease-a', 'unused-lease', 'lease-b', 'lease-c'),
    });
    const input = requestInput({
      id: 'mlr_deauthorize',
      requestDigest: 'deauthorize-digest',
      kind: 'deauthorize',
      confirmationCodeHash: undefined,
    });
    await repository.createOrGetRequest(input);

    await expect(repository.listRetryableRequestDigests()).resolves.toEqual([
      input.requestDigest,
    ]);
    const firstClaim = await repository.claimRequest(input.requestDigest, 120);
    expect(firstClaim?.leaseToken).toBe('lease-a');
    await expect(repository.claimRequest(input.requestDigest, 120)).resolves.toBeUndefined();
    await expect(repository.listRetryableRequestDigests()).resolves.toEqual([]);

    now = new Date('2026-07-20T06:02:01.000Z');
    await expect(repository.listRetryableRequestDigests()).resolves.toEqual([
      input.requestDigest,
    ]);
    const secondClaim = await repository.claimRequest(input.requestDigest, 120);
    expect(secondClaim).toMatchObject({ leaseToken: 'lease-b', attemptCount: 2 });
    if (!firstClaim || !secondClaim) throw new Error('Expected lifecycle claims');

    await expect(
      repository.deferRequest(input.requestDigest, firstClaim.leaseToken, 'stale_worker', 60),
    ).resolves.toBe(false);
    await expect(
      repository.deferRequest(input.requestDigest, secondClaim.leaseToken, 'r2_unavailable', 60),
    ).resolves.toBe(true);
    await expect(repository.listRetryableRequestDigests()).resolves.toEqual([]);

    now = new Date('2026-07-20T06:03:01.000Z');
    const thirdClaim = await repository.claimRequest(input.requestDigest, 120);
    expect(thirdClaim).toMatchObject({ leaseToken: 'lease-c', attemptCount: 3 });
    if (!thirdClaim) throw new Error('Expected third lifecycle claim');
    await expect(
      repository.completeRequest(input.requestDigest, secondClaim.leaseToken),
    ).resolves.toBe(false);
    await expect(
      repository.completeRequest(input.requestDigest, thirdClaim.leaseToken),
    ).resolves.toBe(true);
  });
});

describe('MetaLifecycleRepository cross-tenant deletion', () => {
  it('finds every matching tenant but rechecks the issued_at cutoff before mutation', async () => {
    await insertTenant('tenant-a', 'user-a');
    await insertTenant('tenant-b', 'user-b');
    await insertTenant('tenant-c', 'user-c');
    await insertTenant('tenant-d', 'user-d');
    const oldConnection = await insertConnection({
      id: 'connection-old',
      tenantId: 'tenant-a',
      createdAt: '2026-07-20T05:00:00.000Z',
    });
    const racedConnection = await insertConnection({
      id: 'connection-raced',
      tenantId: 'tenant-b',
      lastVerifiedAt: '2026-07-20T06:00:00.000Z',
      createdAt: '2026-07-20T05:01:00.000Z',
    });
    await insertConnection({
      id: 'connection-new',
      tenantId: 'tenant-c',
      lastVerifiedAt: '2026-07-20T06:00:01.000Z',
      createdAt: '2026-07-20T05:02:00.000Z',
    });
    await insertConnection({
      id: 'connection-manual',
      tenantId: 'tenant-d',
      connectionMode: 'manual_handoff',
      createdAt: '2026-07-20T05:03:00.000Z',
    });

    const repository = new MetaLifecycleRepository(env.DB, {
      now: () => new Date(REQUESTED_AT),
    });
    await expect(
      repository.listMatchingConnections(PLATFORM_USER_ID, ISSUED_AT),
    ).resolves.toEqual([oldConnection, racedConnection]);

    await env.DB
      .prepare(
        `UPDATE threads_connections SET last_verified_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind('2026-07-20T06:00:02.000Z', racedConnection.id, racedConnection.tenantId)
      .run();
    await expect(
      repository.prepareConnectionDeletion(racedConnection, PLATFORM_USER_ID, ISSUED_AT),
    ).resolves.toBe(false);
    await expect(
      repository.prepareConnectionDeletion(
        { ...oldConnection, tenantId: racedConnection.tenantId },
        PLATFORM_USER_ID,
        ISSUED_AT,
      ),
    ).resolves.toBe(false);
    await expect(
      repository.prepareConnectionDeletion(oldConnection, PLATFORM_USER_ID, ISSUED_AT),
    ).resolves.toBe(true);

    const statuses = await env.DB
      .prepare(
        `SELECT id, status FROM threads_connections
         WHERE id IN ('connection-old', 'connection-raced', 'connection-new')
         ORDER BY id`,
      )
      .all<{ id: string; status: string }>();
    expect(statuses.results).toEqual([
      { id: 'connection-new', status: 'connected' },
      { id: 'connection-old', status: 'revoking' },
      { id: 'connection-raced', status: 'connected' },
    ]);
  });

  it('uses the OAuth grant boundary and treats the lifecycle issued_at second as eligible', async () => {
    await insertTenant('tenant-same-second', 'user-same-second');
    await insertTenant('tenant-new-grant', 'user-new-grant');
    const sameSecond = await insertConnection({
      id: 'connection-same-second',
      tenantId: 'tenant-same-second',
      oauthGrantedAt: ISSUED_AT,
      lastVerifiedAt: '2026-07-20T06:30:00.000Z',
    });
    await insertConnection({
      id: 'connection-new-grant',
      tenantId: 'tenant-new-grant',
      oauthGrantedAt: ISSUED_AT + 1,
      lastVerifiedAt: '2026-07-20T05:00:00.000Z',
    });

    const repository = new MetaLifecycleRepository(env.DB, {
      now: () => new Date(REQUESTED_AT),
    });
    await expect(
      repository.listMatchingConnections(PLATFORM_USER_ID, ISSUED_AT),
    ).resolves.toEqual([sameSecond]);
    await expect(
      repository.prepareConnectionDeletion(sameSecond, PLATFORM_USER_ID, ISSUED_AT),
    ).resolves.toBe(true);
  });

  it('requires every R2 object to be marked deleted before atomically clearing audits and data', async () => {
    await insertTenant('tenant-target', 'user-target');
    await insertTenant('tenant-other', 'user-other');
    const target = await insertConnection({
      id: 'connection-target',
      tenantId: 'tenant-target',
      status: 'revoking',
    });
    const other = await insertConnection({
      id: 'connection-other',
      tenantId: 'tenant-other',
      status: 'revoking',
      platformUserId: OTHER_PLATFORM_USER_ID,
    });
    await insertEvidence(
      'evidence-a',
      target.tenantId,
      target.id,
      '2026-07-20T05:00:00.000Z',
    );
    await insertEvidence(
      'evidence-b',
      target.tenantId,
      target.id,
      '2026-07-20T05:01:00.000Z',
    );
    await insertEvidence(
      'evidence-other',
      other.tenantId,
      other.id,
      '2026-07-20T05:00:00.000Z',
    );
    await insertJob('job-target', target.tenantId, target.id);
    await insertJob('job-other', other.tenantId, other.id);
    await insertAudit('audit-direct', target.tenantId, target.id, null);
    await insertAudit('audit-job-only', target.tenantId, null, 'job-target');
    await insertAudit('audit-unrelated', target.tenantId, null, null);
    await insertAudit('audit-other', other.tenantId, other.id, 'job-other');

    const repository = new MetaLifecycleRepository(env.DB, {
      now: () => new Date(REQUESTED_AT),
    });
    await expect(repository.hardDeleteConnection(target)).resolves.toBe(false);
    await expect(
      env.DB.prepare(`SELECT COUNT(*) AS count FROM audit_events`).first<{ count: number }>(),
    ).resolves.toEqual({ count: 4 });

    await expect(repository.listEvidenceBatch(target, 1)).resolves.toEqual([
      { id: 'evidence-a', key: 'evidence/evidence-a' },
    ]);
    await expect(
      repository.markEvidenceDeleted(target, [
        'evidence-a',
        'evidence-a',
        'evidence-other',
      ]),
    ).resolves.toBe(1);
    await expect(repository.hardDeleteConnection(target)).resolves.toBe(false);
    await expect(repository.markEvidenceDeleted(target, ['evidence-b'])).resolves.toBe(1);
    await expect(repository.listEvidenceBatch(target)).resolves.toEqual([]);
    const deletionResult = await repository.hardDeleteConnection(target);
    const targetAfterDeletion = await env.DB
      .prepare(`SELECT id FROM threads_connections WHERE id = ?`)
      .bind(target.id)
      .first<{ id: string }>();
    expect({ deletionResult, targetAfterDeletion }).toEqual({
      deletionResult: true,
      targetAfterDeletion: null,
    });

    await expect(
      env.DB
        .prepare(`SELECT id FROM threads_connections ORDER BY id`)
        .all<{ id: string }>(),
    ).resolves.toMatchObject({ results: [{ id: other.id }] });
    await expect(
      env.DB.prepare(`SELECT id FROM evidence_objects ORDER BY id`).all<{ id: string }>(),
    ).resolves.toMatchObject({ results: [{ id: 'evidence-other' }] });
    await expect(
      env.DB.prepare(`SELECT id FROM audit_events ORDER BY id`).all<{ id: string }>(),
    ).resolves.toMatchObject({
      results: [{ id: 'audit-other' }, { id: 'audit-unrelated' }],
    });
  });
});
