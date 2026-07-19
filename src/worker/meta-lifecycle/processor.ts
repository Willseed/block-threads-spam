import type {
  MetaLifecycleClaim,
  MetaLifecycleConnection,
  MetaLifecycleKind,
  MetaLifecycleRepository,
  NewMetaLifecycleRequest,
} from '../../platform/d1/meta-lifecycle-repository';
import { MetaLifecycleRepository as D1MetaLifecycleRepository } from '../../platform/d1/meta-lifecycle-repository';
import { connectionCoordinator } from '../coordinator';
import type { AppBindings } from '../environment';

const REQUEST_DIGEST_DOMAIN = 'threads-meta-lifecycle-request-v1';
const CONFIRMATION_CODE_DOMAIN = 'threads-meta-lifecycle-confirmation-v1';
const PLATFORM_SUBJECT_DOMAIN = 'threads-meta-lifecycle-platform-subject-v1';
const RECEIPT_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;
const CONNECTION_BATCH_SIZE = 10;
const EVIDENCE_BATCH_SIZE = 100;
const EVIDENCE_BUDGET_PER_ATTEMPT = 1000;
const WORK_REMAINING_DELAY_SECONDS = 30;
const INITIAL_RETRY_DELAY_SECONDS = 300;
const MAX_RETRY_DELAY_SECONDS = 86_400;

const encoder = new TextEncoder();

export type MetaLifecycleBindings = Pick<
  AppBindings,
  | 'DB'
  | 'EVIDENCE'
  | 'CONNECTION_COORDINATOR'
  | 'COORDINATOR_NAMESPACE_KEY'
>;

export interface MetaLifecycleIdentity {
  userId: string;
  issuedAt: number;
}

export interface RegisteredMetaLifecycleRequest {
  requestDigest: string;
  confirmationCode?: string;
}

export type MetaLifecycleProcessResult = 'completed' | 'deferred' | 'not_claimed';

export interface MetaLifecycleRetryResult {
  claimed: number;
  completed: number;
  deferred: number;
}

export type MetaLifecycleRepositoryPort = Pick<
  MetaLifecycleRepository,
  | 'createOrGetRequest'
  | 'claimRequest'
  | 'listRetryableRequestDigests'
  | 'listMatchingConnections'
  | 'prepareConnectionDeletion'
  | 'listEvidenceBatch'
  | 'markEvidenceDeleted'
  | 'hardDeleteConnection'
  | 'completeRequest'
  | 'deferRequest'
  | 'statusByConfirmationHash'
  | 'purgeExpiredReceipts'
>;

interface CoordinatorPort {
  ownerDigest: string;
  stub: {
    revoke(ownerDigest: string, expectedVersion: number): Promise<number | undefined>;
  };
}

export interface MetaLifecycleProcessorDependencies {
  repository?: MetaLifecycleRepositoryPort;
  coordinatorFactory?: (
    bindings: MetaLifecycleBindings,
    tenantId: string,
    connectionId: string,
  ) => Promise<CoordinatorPort>;
  evidenceBucket?: Pick<R2Bucket, 'delete'>;
  idFactory?: () => string;
  now?: () => Date;
}

interface ProcessorServices {
  repository: MetaLifecycleRepositoryPort;
  coordinatorFactory: NonNullable<
    MetaLifecycleProcessorDependencies['coordinatorFactory']
  >;
  evidenceBucket: Pick<R2Bucket, 'delete'>;
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function namespaceKey(value: string | undefined): string {
  if (!value || encoder.encode(value).byteLength < 32) {
    throw new Error('Meta lifecycle processor is not configured');
  }
  return value;
}

function validIdentity(identity: MetaLifecycleIdentity): void {
  validPlatformUserId(identity.userId);
  if (!Number.isSafeInteger(identity.issuedAt) || identity.issuedAt <= 0) {
    throw new TypeError('Invalid Meta lifecycle identity');
  }
}

function validPlatformUserId(userId: string): void {
  if (!/^[1-9][0-9]{0,31}$/u.test(userId)) {
    throw new TypeError('Invalid Meta lifecycle identity');
  }
}

function validKind(kind: unknown): asserts kind is MetaLifecycleKind {
  if (kind !== 'deauthorize' && kind !== 'data_deletion') {
    throw new TypeError('Invalid Meta lifecycle kind');
  }
}

async function hmacHex(keyMaterial: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function deriveMetaPlatformSubjectDigest(
  bindings: Pick<MetaLifecycleBindings, 'COORDINATOR_NAMESPACE_KEY'>,
  platformUserId: string,
): Promise<string> {
  validPlatformUserId(platformUserId);
  return hmacHex(
    namespaceKey(bindings.COORDINATOR_NAMESPACE_KEY),
    `${PLATFORM_SUBJECT_DOMAIN}\0${platformUserId}`,
  );
}

function services(
  bindings: MetaLifecycleBindings,
  dependencies: MetaLifecycleProcessorDependencies,
): ProcessorServices {
  const now = dependencies.now ?? (() => new Date());
  return {
    repository:
      dependencies.repository ?? new D1MetaLifecycleRepository(bindings.DB, { now }),
    coordinatorFactory:
      dependencies.coordinatorFactory ??
      (async (selectedBindings, tenantId, connectionId) =>
        connectionCoordinator(selectedBindings, tenantId, connectionId)),
    evidenceBucket: dependencies.evidenceBucket ?? bindings.EVIDENCE,
  };
}

function retryDelaySeconds(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 8);
  return Math.min(
    INITIAL_RETRY_DELAY_SECONDS * 2 ** exponent,
    MAX_RETRY_DELAY_SECONDS,
  );
}

async function deferClaim(
  repository: MetaLifecycleRepositoryPort,
  claim: MetaLifecycleClaim,
  errorClass: string,
  delaySeconds: number,
): Promise<MetaLifecycleProcessResult> {
  const deferred = await repository.deferRequest(
    claim.requestDigest,
    claim.leaseToken,
    errorClass,
    delaySeconds,
  );
  return deferred ? 'deferred' : 'not_claimed';
}

async function revokeConnection(
  bindings: MetaLifecycleBindings,
  selectedServices: ProcessorServices,
  connection: MetaLifecycleConnection,
): Promise<void> {
  const coordinator = await selectedServices.coordinatorFactory(
    bindings,
    connection.tenantId,
    connection.id,
  );
  const version = await coordinator.stub.revoke(
    coordinator.ownerDigest,
    connection.revocationVersion,
  );
  if (version === undefined) throw new Error('Meta lifecycle coordinator conflict');
}

async function purgeConnectionEvidence(
  selectedServices: ProcessorServices,
  connection: MetaLifecycleConnection,
  evidenceBudget: { remaining: number },
): Promise<boolean> {
  while (evidenceBudget.remaining > 0) {
    const limit = Math.min(EVIDENCE_BATCH_SIZE, evidenceBudget.remaining);
    const evidence = await selectedServices.repository.listEvidenceBatch(
      connection,
      limit,
    );
    if (evidence.length === 0) return true;

    await selectedServices.evidenceBucket.delete(evidence.map((item) => item.key));
    await selectedServices.repository.markEvidenceDeleted(
      connection,
      evidence.map((item) => item.id),
    );
    evidenceBudget.remaining -= evidence.length;
  }

  const remaining = await selectedServices.repository.listEvidenceBatch(connection, 1);
  return remaining.length === 0;
}

async function processClaim(
  bindings: MetaLifecycleBindings,
  selectedServices: ProcessorServices,
  claim: MetaLifecycleClaim,
): Promise<{ workRemaining: boolean; failureClass?: string }> {
  let connections: MetaLifecycleConnection[];
  try {
    connections = await selectedServices.repository.listMatchingConnections(
      claim.platformUserId,
      claim.issuedAt,
      CONNECTION_BATCH_SIZE,
    );
  } catch {
    return { workRemaining: true, failureClass: 'connection_lookup' };
  }

  const evidenceBudget = { remaining: EVIDENCE_BUDGET_PER_ATTEMPT };
  for (const connection of connections) {
    if (evidenceBudget.remaining === 0) break;

    let prepared: boolean;
    try {
      prepared = await selectedServices.repository.prepareConnectionDeletion(
        connection,
        claim.platformUserId,
        claim.issuedAt,
      );
    } catch {
      return { workRemaining: true, failureClass: 'connection_prepare' };
    }
    if (!prepared) continue;

    try {
      await revokeConnection(bindings, selectedServices, connection);
    } catch {
      return { workRemaining: true, failureClass: 'coordinator_revoke' };
    }

    let evidencePurged: boolean;
    try {
      evidencePurged = await purgeConnectionEvidence(
        selectedServices,
        connection,
        evidenceBudget,
      );
    } catch {
      return { workRemaining: true, failureClass: 'evidence_delete' };
    }
    if (!evidencePurged) return { workRemaining: true };

    try {
      await selectedServices.repository.hardDeleteConnection(connection);
    } catch {
      return { workRemaining: true, failureClass: 'connection_delete' };
    }
  }

  try {
    const remainingConnections = await selectedServices.repository.listMatchingConnections(
      claim.platformUserId,
      claim.issuedAt,
      1,
    );
    return { workRemaining: remainingConnections.length > 0 };
  } catch {
    return { workRemaining: true, failureClass: 'connection_recheck' };
  }
}

export async function registerMetaLifecycleRequest(
  bindings: MetaLifecycleBindings,
  kind: MetaLifecycleKind,
  identity: MetaLifecycleIdentity,
  dependencies: MetaLifecycleProcessorDependencies = {},
): Promise<RegisteredMetaLifecycleRequest> {
  validKind(kind);
  validIdentity(identity);
  const keyMaterial = namespaceKey(bindings.COORDINATOR_NAMESPACE_KEY);
  const requestDigest = await hmacHex(
    keyMaterial,
    `${REQUEST_DIGEST_DOMAIN}\0${kind}\0${identity.userId}\0${identity.issuedAt}`,
  );
  const platformSubjectDigest = await deriveMetaPlatformSubjectDigest(
    bindings,
    identity.userId,
  );
  const confirmationCode =
    kind === 'data_deletion'
      ? await hmacHex(
          keyMaterial,
          `${CONFIRMATION_CODE_DOMAIN}\0${requestDigest}`,
        )
      : undefined;

  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Meta lifecycle processor clock is invalid');
  }
  const input: NewMetaLifecycleRequest = {
    id: `mlr_${dependencies.idFactory?.() ?? crypto.randomUUID()}`,
    requestDigest,
    kind,
    platformUserId: identity.userId,
    platformSubjectDigest,
    issuedAt: identity.issuedAt,
    ...(confirmationCode
      ? { confirmationCodeHash: await sha256Hex(confirmationCode) }
      : {}),
    expiresAt: new Date(now.getTime() + RECEIPT_RETENTION_MILLISECONDS).toISOString(),
  };
  await services(bindings, dependencies).repository.createOrGetRequest(input);

  return {
    requestDigest,
    ...(confirmationCode ? { confirmationCode } : {}),
  };
}

export async function processMetaLifecycleRequest(
  bindings: MetaLifecycleBindings,
  requestDigest: string,
  dependencies: MetaLifecycleProcessorDependencies = {},
): Promise<MetaLifecycleProcessResult> {
  if (!/^[a-f0-9]{64}$/u.test(requestDigest)) {
    throw new TypeError('Invalid Meta lifecycle request digest');
  }
  const selectedServices = services(bindings, dependencies);
  const claim = await selectedServices.repository.claimRequest(requestDigest);
  if (!claim) return 'not_claimed';

  const outcome = await processClaim(bindings, selectedServices, claim);
  if (outcome.failureClass) {
    return deferClaim(
      selectedServices.repository,
      claim,
      outcome.failureClass,
      retryDelaySeconds(claim.attemptCount),
    );
  }
  if (outcome.workRemaining) {
    return deferClaim(
      selectedServices.repository,
      claim,
      'work_remaining',
      WORK_REMAINING_DELAY_SECONDS,
    );
  }

  const completed = await selectedServices.repository.completeRequest(
    claim.requestDigest,
    claim.leaseToken,
  );
  return completed ? 'completed' : 'not_claimed';
}

export async function runMetaLifecycleRetries(
  bindings: MetaLifecycleBindings,
  limit = 10,
  dependencies: MetaLifecycleProcessorDependencies = {},
): Promise<MetaLifecycleRetryResult> {
  const selectedServices = services(bindings, dependencies);
  const requestDigests = await selectedServices.repository.listRetryableRequestDigests(limit);
  const result: MetaLifecycleRetryResult = { claimed: 0, completed: 0, deferred: 0 };

  for (const requestDigest of requestDigests) {
    let outcome: MetaLifecycleProcessResult;
    try {
      outcome = await processMetaLifecycleRequest(bindings, requestDigest, {
        ...dependencies,
        repository: selectedServices.repository,
        coordinatorFactory: selectedServices.coordinatorFactory,
        evidenceBucket: selectedServices.evidenceBucket,
      });
    } catch {
      result.claimed += 1;
      result.deferred += 1;
      continue;
    }
    if (outcome === 'not_claimed') continue;
    result.claimed += 1;
    if (outcome === 'completed') result.completed += 1;
    else result.deferred += 1;
  }
  return result;
}

export async function metaLifecycleStatus(
  bindings: MetaLifecycleBindings,
  confirmationCode: string,
  dependencies: MetaLifecycleProcessorDependencies = {},
): Promise<'pending' | 'completed' | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(confirmationCode)) return undefined;
  return services(bindings, dependencies).repository.statusByConfirmationHash(
    await sha256Hex(confirmationCode),
  );
}

export async function purgeExpiredMetaLifecycleReceipts(
  bindings: MetaLifecycleBindings,
  limit = 100,
  dependencies: MetaLifecycleProcessorDependencies = {},
): Promise<number> {
  return services(bindings, dependencies).repository.purgeExpiredReceipts(limit);
}
