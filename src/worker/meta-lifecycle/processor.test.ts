import { describe, expect, it, vi } from 'vitest';

import type {
  MetaLifecycleClaim,
  MetaLifecycleConnection,
  MetaLifecycleRequestRecord,
  NewMetaLifecycleRequest,
} from '../../platform/d1/meta-lifecycle-repository';
import {
  metaLifecycleStatus,
  processMetaLifecycleRequest,
  purgeExpiredMetaLifecycleReceipts,
  registerMetaLifecycleRequest,
  runMetaLifecycleRetries,
} from './processor';
import type {
  MetaLifecycleBindings,
  MetaLifecycleProcessorDependencies,
  MetaLifecycleRepositoryPort,
} from './processor';

const NAMESPACE_KEY = 'processor-test-namespace-key-material-1234567890';
const NOW = new Date('2026-07-20T06:00:00.000Z');
const ISSUED_AT = Math.floor(NOW.getTime() / 1000);
const PLATFORM_USER_ID = '17841400000000001';
const REQUEST_DIGEST = 'a'.repeat(64);

function bindings(): MetaLifecycleBindings {
  return {
    DB: {} as D1Database,
    EVIDENCE: {} as R2Bucket,
    CONNECTION_COORDINATOR:
      {} as MetaLifecycleBindings['CONNECTION_COORDINATOR'],
    COORDINATOR_NAMESPACE_KEY: NAMESPACE_KEY,
  };
}

function requestRecord(input: NewMetaLifecycleRequest): MetaLifecycleRequestRecord {
  return {
    id: input.id,
    requestDigest: input.requestDigest,
    kind: input.kind,
    platformUserId: input.platformUserId,
    issuedAt: input.issuedAt,
    status: 'pending',
    attemptCount: 0,
  };
}

function claimedRequest(
  requestDigest = REQUEST_DIGEST,
  overrides: Partial<MetaLifecycleClaim> = {},
): MetaLifecycleClaim {
  return {
    id: `mlr_${requestDigest.slice(0, 8)}`,
    requestDigest,
    kind: 'data_deletion',
    platformUserId: PLATFORM_USER_ID,
    issuedAt: ISSUED_AT,
    status: 'processing',
    attemptCount: 1,
    leaseToken: `lease-${requestDigest.slice(0, 8)}`,
    ...overrides,
  };
}

function repository(
  overrides: Partial<MetaLifecycleRepositoryPort> = {},
): MetaLifecycleRepositoryPort {
  return {
    createOrGetRequest: vi
      .fn<MetaLifecycleRepositoryPort['createOrGetRequest']>()
      .mockImplementation((input) => Promise.resolve(requestRecord(input))),
    claimRequest: vi
      .fn<MetaLifecycleRepositoryPort['claimRequest']>()
      .mockResolvedValue(undefined),
    listRetryableRequestDigests: vi
      .fn<MetaLifecycleRepositoryPort['listRetryableRequestDigests']>()
      .mockResolvedValue([]),
    listMatchingConnections: vi
      .fn<MetaLifecycleRepositoryPort['listMatchingConnections']>()
      .mockResolvedValue([]),
    prepareConnectionDeletion: vi
      .fn<MetaLifecycleRepositoryPort['prepareConnectionDeletion']>()
      .mockResolvedValue(true),
    listEvidenceBatch: vi
      .fn<MetaLifecycleRepositoryPort['listEvidenceBatch']>()
      .mockResolvedValue([]),
    markEvidenceDeleted: vi
      .fn<MetaLifecycleRepositoryPort['markEvidenceDeleted']>()
      .mockImplementation((_connection, evidenceIds) => Promise.resolve(evidenceIds.length)),
    hardDeleteConnection: vi
      .fn<MetaLifecycleRepositoryPort['hardDeleteConnection']>()
      .mockResolvedValue(true),
    completeRequest: vi
      .fn<MetaLifecycleRepositoryPort['completeRequest']>()
      .mockResolvedValue(true),
    deferRequest: vi
      .fn<MetaLifecycleRepositoryPort['deferRequest']>()
      .mockResolvedValue(true),
    statusByConfirmationHash: vi
      .fn<MetaLifecycleRepositoryPort['statusByConfirmationHash']>()
      .mockResolvedValue(undefined),
    purgeExpiredReceipts: vi
      .fn<MetaLifecycleRepositoryPort['purgeExpiredReceipts']>()
      .mockResolvedValue(0),
    ...overrides,
  };
}

function processorDependencies(
  selectedRepository: MetaLifecycleRepositoryPort,
  overrides: Partial<MetaLifecycleProcessorDependencies> = {},
): MetaLifecycleProcessorDependencies {
  return {
    repository: selectedRepository,
    now: () => NOW,
    idFactory: () => 'deterministic-request-id',
    coordinatorFactory: () => Promise.resolve({
      ownerDigest: 'f'.repeat(64),
      stub: {
        revoke: (_ownerDigest, expectedVersion) => Promise.resolve(expectedVersion + 1),
      },
    }),
    evidenceBucket: { delete: () => Promise.resolve() },
    ...overrides,
  };
}

describe('Meta lifecycle request registration', () => {
  it('derives deterministic domain-separated request and confirmation values', async () => {
    const inputs: NewMetaLifecycleRequest[] = [];
    const selectedRepository = repository({
      createOrGetRequest: vi
        .fn<MetaLifecycleRepositoryPort['createOrGetRequest']>()
        .mockImplementation((input) => {
          inputs.push(input);
          return Promise.resolve(requestRecord(input));
        }),
    });
    const dependencies = processorDependencies(selectedRepository);

    const first = await registerMetaLifecycleRequest(
      bindings(),
      'data_deletion',
      { userId: PLATFORM_USER_ID, issuedAt: ISSUED_AT },
      dependencies,
    );
    const replay = await registerMetaLifecycleRequest(
      bindings(),
      'data_deletion',
      { userId: PLATFORM_USER_ID, issuedAt: ISSUED_AT },
      dependencies,
    );
    const deauthorize = await registerMetaLifecycleRequest(
      bindings(),
      'deauthorize',
      { userId: PLATFORM_USER_ID, issuedAt: ISSUED_AT },
      dependencies,
    );

    expect(first).toEqual(replay);
    expect(first.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.confirmationCode).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.requestDigest).not.toContain(PLATFORM_USER_ID);
    expect(first.confirmationCode).not.toContain(PLATFORM_USER_ID);
    expect(deauthorize.requestDigest).not.toBe(first.requestDigest);
    expect(deauthorize).not.toHaveProperty('confirmationCode');
    expect(inputs[0]).toMatchObject({
      kind: 'data_deletion',
      platformUserId: PLATFORM_USER_ID,
      expiresAt: '2026-10-18T06:00:00.000Z',
    });
    expect(inputs[0]?.platformSubjectDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(inputs[0]?.platformSubjectDigest).not.toContain(PLATFORM_USER_ID);
    expect(inputs[0]?.platformSubjectDigest).not.toBe(first.requestDigest);
    expect(inputs[1]?.platformSubjectDigest).toBe(inputs[0]?.platformSubjectDigest);
    expect(inputs[2]?.platformSubjectDigest).toBe(inputs[0]?.platformSubjectDigest);
    expect(inputs[0]?.confirmationCodeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(inputs[0]?.confirmationCodeHash).not.toBe(first.confirmationCode);
    expect(inputs[2]).not.toHaveProperty('confirmationCodeHash');
  });

  it('fails closed when lifecycle identity or namespace key is invalid', async () => {
    const selectedRepository = repository();
    const dependencies = processorDependencies(selectedRepository);

    await expect(
      registerMetaLifecycleRequest(
        { ...bindings(), COORDINATOR_NAMESPACE_KEY: 'too-short' },
        'data_deletion',
        { userId: PLATFORM_USER_ID, issuedAt: ISSUED_AT },
        dependencies,
      ),
    ).rejects.toThrow('not configured');
    await expect(
      registerMetaLifecycleRequest(
        bindings(),
        'data_deletion',
        { userId: 'not-a-meta-id', issuedAt: ISSUED_AT },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('Meta lifecycle processing', () => {
  it('revokes, purges and hard-deletes every matching tenant before completing', async () => {
    const events: string[] = [];
    const connections: MetaLifecycleConnection[] = [
      { id: 'connection-a', tenantId: 'tenant-a', revocationVersion: 2 },
      { id: 'connection-b', tenantId: 'tenant-b', revocationVersion: 5 },
    ];
    let connectionLookupCount = 0;
    const evidenceLookupCount = new Map<string, number>();
    const selectedRepository = repository({
      claimRequest: vi
        .fn<MetaLifecycleRepositoryPort['claimRequest']>()
        .mockResolvedValue(claimedRequest()),
      listMatchingConnections: vi
        .fn<MetaLifecycleRepositoryPort['listMatchingConnections']>()
        .mockImplementation((userId, issuedAt, limit) => {
          events.push(`connections:${userId}:${issuedAt}:${limit}`);
          connectionLookupCount += 1;
          return Promise.resolve(connectionLookupCount === 1 ? connections : []);
        }),
      prepareConnectionDeletion: vi
        .fn<MetaLifecycleRepositoryPort['prepareConnectionDeletion']>()
        .mockImplementation((connection, userId, issuedAt) => {
          events.push(`prepare:${connection.tenantId}:${connection.id}:${userId}:${issuedAt}`);
          return Promise.resolve(true);
        }),
      listEvidenceBatch: vi
        .fn<MetaLifecycleRepositoryPort['listEvidenceBatch']>()
        .mockImplementation((connection) => {
          events.push(`evidence:${connection.id}`);
          const count = evidenceLookupCount.get(connection.id) ?? 0;
          evidenceLookupCount.set(connection.id, count + 1);
          return Promise.resolve(
            count === 0
              ? [{ id: `evidence-${connection.id}`, key: `r2/${connection.id}` }]
              : [],
          );
        }),
      markEvidenceDeleted: vi
        .fn<MetaLifecycleRepositoryPort['markEvidenceDeleted']>()
        .mockImplementation((connection, evidenceIds) => {
          events.push(`mark:${connection.id}:${evidenceIds.join(',')}`);
          return Promise.resolve(evidenceIds.length);
        }),
      hardDeleteConnection: vi
        .fn<MetaLifecycleRepositoryPort['hardDeleteConnection']>()
        .mockImplementation((connection) => {
          events.push(`hard-delete:${connection.tenantId}:${connection.id}`);
          return Promise.resolve(true);
        }),
      completeRequest: vi
        .fn<MetaLifecycleRepositoryPort['completeRequest']>()
        .mockImplementation((digest, leaseToken) => {
          events.push(`complete:${digest}:${leaseToken}`);
          return Promise.resolve(true);
        }),
    });
    const dependencies = processorDependencies(selectedRepository, {
      coordinatorFactory: (_selectedBindings, tenantId, connectionId) =>
        Promise.resolve({
          ownerDigest: `${tenantId}-${connectionId}`,
          stub: {
            revoke: (ownerDigest, expectedVersion) => {
              events.push(`revoke:${ownerDigest}:${expectedVersion}`);
              return Promise.resolve(expectedVersion + 1);
            },
          },
        }),
      evidenceBucket: {
        delete: (keys) => {
          events.push(`r2-delete:${Array.isArray(keys) ? keys.join(',') : keys}`);
          return Promise.resolve();
        },
      },
    });

    await expect(
      processMetaLifecycleRequest(bindings(), REQUEST_DIGEST, dependencies),
    ).resolves.toBe('completed');

    expect(events).toEqual([
      `connections:${PLATFORM_USER_ID}:${ISSUED_AT}:10`,
      `prepare:tenant-a:connection-a:${PLATFORM_USER_ID}:${ISSUED_AT}`,
      'revoke:tenant-a-connection-a:2',
      'evidence:connection-a',
      'r2-delete:r2/connection-a',
      'mark:connection-a:evidence-connection-a',
      'evidence:connection-a',
      'hard-delete:tenant-a:connection-a',
      `prepare:tenant-b:connection-b:${PLATFORM_USER_ID}:${ISSUED_AT}`,
      'revoke:tenant-b-connection-b:5',
      'evidence:connection-b',
      'r2-delete:r2/connection-b',
      'mark:connection-b:evidence-connection-b',
      'evidence:connection-b',
      'hard-delete:tenant-b:connection-b',
      `connections:${PLATFORM_USER_ID}:${ISSUED_AT}:1`,
      `complete:${REQUEST_DIGEST}:lease-aaaaaaaa`,
    ]);
  });

  it('defers with a bounded non-PII class when evidence storage fails', async () => {
    const connection = {
      id: 'connection-a',
      tenantId: 'tenant-a',
      revocationVersion: 0,
    };
    const deferRequest = vi
      .fn<MetaLifecycleRepositoryPort['deferRequest']>()
      .mockResolvedValue(true);
    const hardDeleteConnection = vi
      .fn<MetaLifecycleRepositoryPort['hardDeleteConnection']>()
      .mockResolvedValue(true);
    const selectedRepository = repository({
      claimRequest: vi
        .fn<MetaLifecycleRepositoryPort['claimRequest']>()
        .mockResolvedValue(claimedRequest(REQUEST_DIGEST, { attemptCount: 3 })),
      listMatchingConnections: vi
        .fn<MetaLifecycleRepositoryPort['listMatchingConnections']>()
        .mockResolvedValue([connection]),
      listEvidenceBatch: vi
        .fn<MetaLifecycleRepositoryPort['listEvidenceBatch']>()
        .mockResolvedValue([{ id: 'evidence-a', key: 'r2/private-a' }]),
      deferRequest,
      hardDeleteConnection,
    });
    const dependencies = processorDependencies(selectedRepository, {
      evidenceBucket: {
        delete: () => Promise.reject(new Error(`must not persist ${PLATFORM_USER_ID}`)),
      },
    });

    await expect(
      processMetaLifecycleRequest(bindings(), REQUEST_DIGEST, dependencies),
    ).resolves.toBe('deferred');
    expect(deferRequest).toHaveBeenCalledWith(
      REQUEST_DIGEST,
      'lease-aaaaaaaa',
      'evidence_delete',
      1200,
    );
    expect(JSON.stringify(deferRequest.mock.calls)).not.toContain(PLATFORM_USER_ID);
    expect(hardDeleteConnection).not.toHaveBeenCalled();
  });

  it('defers bounded work when more matching connections remain', async () => {
    const firstBatch = Array.from({ length: 10 }, (_, index) => ({
      id: `connection-${index}`,
      tenantId: `tenant-${index}`,
      revocationVersion: 0,
    }));
    let lookupCount = 0;
    const deferRequest = vi
      .fn<MetaLifecycleRepositoryPort['deferRequest']>()
      .mockResolvedValue(true);
    const selectedRepository = repository({
      claimRequest: vi
        .fn<MetaLifecycleRepositoryPort['claimRequest']>()
        .mockResolvedValue(claimedRequest()),
      listMatchingConnections: vi
        .fn<MetaLifecycleRepositoryPort['listMatchingConnections']>()
        .mockImplementation(() => {
          lookupCount += 1;
          return Promise.resolve(lookupCount === 1 ? firstBatch : [firstBatch[0]]);
        }),
      deferRequest,
    });

    await expect(
      processMetaLifecycleRequest(
        bindings(),
        REQUEST_DIGEST,
        processorDependencies(selectedRepository),
      ),
    ).resolves.toBe('deferred');
    expect(deferRequest).toHaveBeenCalledWith(
      REQUEST_DIGEST,
      'lease-aaaaaaaa',
      'work_remaining',
      30,
    );
  });

  it('does not process a request that another worker owns or already completed', async () => {
    const completeRequest = vi
      .fn<MetaLifecycleRepositoryPort['completeRequest']>()
      .mockResolvedValue(true);
    const selectedRepository = repository({ completeRequest });

    await expect(
      processMetaLifecycleRequest(
        bindings(),
        REQUEST_DIGEST,
        processorDependencies(selectedRepository),
      ),
    ).resolves.toBe('not_claimed');
    expect(completeRequest).not.toHaveBeenCalled();
  });

  it('does not claim completion after losing the request lease', async () => {
    const selectedRepository = repository({
      claimRequest: vi
        .fn<MetaLifecycleRepositoryPort['claimRequest']>()
        .mockResolvedValue(claimedRequest()),
      completeRequest: vi
        .fn<MetaLifecycleRepositoryPort['completeRequest']>()
        .mockResolvedValue(false),
    });

    await expect(
      processMetaLifecycleRequest(
        bindings(),
        REQUEST_DIGEST,
        processorDependencies(selectedRepository),
      ),
    ).resolves.toBe('not_claimed');
  });
});

describe('Meta lifecycle maintenance and status', () => {
  it('processes a bounded retry batch sequentially', async () => {
    const digests = ['b'.repeat(64), 'c'.repeat(64)];
    const claims = new Map(
      digests.map((digest) => [digest, claimedRequest(digest)]),
    );
    const selectedRepository = repository({
      listRetryableRequestDigests: vi
        .fn<MetaLifecycleRepositoryPort['listRetryableRequestDigests']>()
        .mockImplementation((limit) => {
          expect(limit).toBe(2);
          return Promise.resolve(digests);
        }),
      claimRequest: vi
        .fn<MetaLifecycleRepositoryPort['claimRequest']>()
        .mockImplementation((digest) => Promise.resolve(claims.get(digest))),
    });

    await expect(
      runMetaLifecycleRetries(
        bindings(),
        2,
        processorDependencies(selectedRepository),
      ),
    ).resolves.toEqual({ claimed: 2, completed: 2, deferred: 0 });
  });

  it('hashes only an exact lowercase 64-character confirmation code for status lookup', async () => {
    const statusByConfirmationHash = vi
      .fn<MetaLifecycleRepositoryPort['statusByConfirmationHash']>()
      .mockResolvedValue('completed');
    const selectedRepository = repository({ statusByConfirmationHash });
    const dependencies = processorDependencies(selectedRepository);
    const code = 'd'.repeat(64);

    await expect(metaLifecycleStatus(bindings(), code, dependencies)).resolves.toBe(
      'completed',
    );
    expect(statusByConfirmationHash).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
    await expect(
      metaLifecycleStatus(bindings(), `${code.slice(0, -1)}_`, dependencies),
    ).resolves.toBeUndefined();
    await expect(
      metaLifecycleStatus(bindings(), code.toUpperCase(), dependencies),
    ).resolves.toBeUndefined();
    expect(statusByConfirmationHash).toHaveBeenCalledTimes(1);
  });

  it('delegates bounded completed-receipt purging to the repository', async () => {
    const purgeExpiredReceipts = vi
      .fn<MetaLifecycleRepositoryPort['purgeExpiredReceipts']>()
      .mockResolvedValue(7);
    const selectedRepository = repository({ purgeExpiredReceipts });

    await expect(
      purgeExpiredMetaLifecycleReceipts(
        bindings(),
        50,
        processorDependencies(selectedRepository),
      ),
    ).resolves.toBe(7);
    expect(purgeExpiredReceipts).toHaveBeenCalledWith(50);
  });
});
