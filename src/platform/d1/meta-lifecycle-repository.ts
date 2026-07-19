export type MetaLifecycleKind = 'deauthorize' | 'data_deletion';
export type MetaLifecycleStatus = 'pending' | 'processing' | 'completed';

export interface MetaLifecycleRequestRecord {
  id: string;
  requestDigest: string;
  kind: MetaLifecycleKind;
  platformUserId?: string;
  issuedAt: number;
  status: MetaLifecycleStatus;
  attemptCount: number;
}

export interface MetaLifecycleClaim extends MetaLifecycleRequestRecord {
  platformUserId: string;
  status: 'processing';
  leaseToken: string;
}

export interface NewMetaLifecycleRequest {
  id: string;
  requestDigest: string;
  kind: MetaLifecycleKind;
  platformUserId: string;
  platformSubjectDigest: string;
  issuedAt: number;
  confirmationCodeHash?: string;
  expiresAt: string;
}

export interface MetaLifecycleConnection {
  id: string;
  tenantId: string;
  revocationVersion: number;
}

export interface MetaLifecycleEvidence {
  id: string;
  key: string;
}

interface RequestRow {
  id: string;
  request_digest: string;
  kind: MetaLifecycleKind;
  platform_user_id: string | null;
  platform_subject_digest: string;
  issued_at: number;
  status: MetaLifecycleStatus;
  attempt_count: number;
  confirmation_code_hash: string | null;
  lease_token: string | null;
}

interface ConnectionRow {
  id: string;
  tenant_id: string;
  revocation_version: number;
}

interface EvidenceRow {
  id: string;
  r2_key: string;
}

interface StatusRow {
  status: MetaLifecycleStatus;
}

interface MetaLifecycleRepositoryOptions {
  now?: () => Date;
  leaseTokenFactory?: () => string;
}

const MAX_OPAQUE_VALUE_LENGTH = 256;

function boundedOpaqueValue(value: string, label: string): string {
  if (!value || value.length > MAX_OPAQUE_VALUE_LENGTH) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function platformIdentifier(value: string): string {
  if (!/^[1-9][0-9]{0,31}$/u.test(value)) {
    throw new TypeError('Invalid Meta platform user ID');
  }
  return value;
}

function lifecycleCutoff(issuedAt: number): { seconds: number; timestamp: string } {
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new TypeError('Invalid Meta lifecycle issued_at');
  }
  const exclusiveSeconds = issuedAt + 1;
  if (!Number.isSafeInteger(exclusiveSeconds)) {
    throw new TypeError('Invalid Meta lifecycle issued_at');
  }
  const cutoff = new Date(exclusiveSeconds * 1000);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new TypeError('Invalid Meta lifecycle issued_at');
  }
  return { seconds: exclusiveSeconds, timestamp: cutoff.toISOString() };
}

function subjectDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError('Invalid Meta platform subject digest');
  }
  return value;
}

function isoTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function requestRecord(row: RequestRow): MetaLifecycleRequestRecord {
  return {
    id: row.id,
    requestDigest: row.request_digest,
    kind: row.kind,
    ...(row.platform_user_id ? { platformUserId: row.platform_user_id } : {}),
    issuedAt: row.issued_at,
    status: row.status,
    attemptCount: row.attempt_count,
  };
}

export class MetaLifecycleRepository {
  readonly #db: D1Database;
  readonly #now: () => Date;
  readonly #leaseTokenFactory: () => string;

  constructor(db: D1Database, options: MetaLifecycleRepositoryOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#leaseTokenFactory = options.leaseTokenFactory ?? (() => crypto.randomUUID());
  }

  async createOrGetRequest(input: NewMetaLifecycleRequest): Promise<MetaLifecycleRequestRecord> {
    const now = this.#now().toISOString();
    boundedOpaqueValue(input.id, 'Meta lifecycle request ID');
    boundedOpaqueValue(input.requestDigest, 'Meta lifecycle request digest');
    platformIdentifier(input.platformUserId);
    subjectDigest(input.platformSubjectDigest);
    lifecycleCutoff(input.issuedAt);
    isoTimestamp(input.expiresAt, 'Meta lifecycle receipt expiry');
    const confirmationCodeHash = input.confirmationCodeHash ?? null;
    if (
      (input.kind === 'data_deletion' && confirmationCodeHash === null) ||
      (input.kind === 'deauthorize' && confirmationCodeHash !== null)
    ) {
      throw new TypeError('Invalid Meta lifecycle confirmation code');
    }
    if (confirmationCodeHash !== null) {
      boundedOpaqueValue(confirmationCodeHash, 'Meta lifecycle confirmation code hash');
    }
    await this.#db
      .prepare(
        `INSERT INTO meta_lifecycle_requests
           (id, request_digest, kind, platform_user_id, platform_subject_digest,
            issued_at, confirmation_code_hash,
            status, next_attempt_at, requested_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT(request_digest) DO NOTHING`,
      )
      .bind(
        input.id,
        input.requestDigest,
        input.kind,
        input.platformUserId,
        input.platformSubjectDigest,
        input.issuedAt,
        confirmationCodeHash,
        now,
        now,
        now,
        input.expiresAt,
      )
      .run();

    const row = await this.#db
      .prepare(
        `SELECT id, request_digest, kind, platform_user_id, platform_subject_digest,
                issued_at, status, attempt_count, confirmation_code_hash, lease_token
         FROM meta_lifecycle_requests
         WHERE request_digest = ?`,
      )
      .bind(input.requestDigest)
      .first<RequestRow>();
    if (
      !row ||
      row.kind !== input.kind ||
      row.platform_subject_digest !== input.platformSubjectDigest ||
      row.issued_at !== input.issuedAt ||
      row.confirmation_code_hash !== confirmationCodeHash ||
      (row.platform_user_id !== null && row.platform_user_id !== input.platformUserId)
    ) {
      throw new Error('Meta lifecycle request could not be persisted');
    }
    return requestRecord(row);
  }

  async claimRequest(
    requestDigest: string,
    leaseSeconds = 120,
  ): Promise<MetaLifecycleClaim | undefined> {
    boundedOpaqueValue(requestDigest, 'Meta lifecycle request digest');
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
      throw new RangeError('Meta lifecycle lease must be between 30 and 600 seconds');
    }
    const now = this.#now();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const leaseToken = boundedOpaqueValue(
      this.#leaseTokenFactory(),
      'Meta lifecycle lease token',
    );
    const row = await this.#db
      .prepare(
        `UPDATE meta_lifecycle_requests
         SET status = 'processing', attempt_count = attempt_count + 1,
             lease_until = ?, lease_token = ?, updated_at = ?, last_error_class = NULL
         WHERE request_digest = ? AND platform_user_id IS NOT NULL
           AND (
             (status = 'pending' AND next_attempt_at <= ?) OR
             (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
           )
         RETURNING id, request_digest, kind, platform_user_id, platform_subject_digest,
                   issued_at, status, attempt_count, confirmation_code_hash, lease_token`,
      )
      .bind(leaseUntil, leaseToken, nowIso, requestDigest, nowIso, nowIso)
      .first<RequestRow>();
    if (!row) return undefined;
    if (row.status !== 'processing' || !row.platform_user_id || !row.lease_token) {
      throw new Error('Meta lifecycle claim is inconsistent');
    }
    return {
      ...requestRecord(row),
      platformUserId: row.platform_user_id,
      status: 'processing',
      leaseToken: row.lease_token,
    };
  }

  async listRetryableRequestDigests(limit = 10): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Meta lifecycle retry limit must be between 1 and 100');
    }
    const now = this.#now().toISOString();
    const { results } = await this.#db
      .prepare(
        `SELECT request_digest
         FROM meta_lifecycle_requests
         WHERE platform_user_id IS NOT NULL
           AND (
             (status = 'pending' AND next_attempt_at <= ?) OR
             (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
           )
         ORDER BY next_attempt_at, requested_at
         LIMIT ?`,
      )
      .bind(now, now, limit)
      .all<{ request_digest: string }>();
    return results.map((row) => row.request_digest);
  }

  async listMatchingConnections(
    platformUserId: string,
    issuedAt: number,
    limit = 10,
  ): Promise<MetaLifecycleConnection[]> {
    platformIdentifier(platformUserId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Meta lifecycle connection limit must be between 1 and 100');
    }
    const cutoff = lifecycleCutoff(issuedAt);
    const { results } = await this.#db
      .prepare(
        `SELECT id, tenant_id, revocation_version
         FROM threads_connections
         WHERE connection_mode = 'meta_oauth' AND platform_user_id = ?
           AND (
             (oauth_granted_at IS NOT NULL AND oauth_granted_at < ?) OR
             (oauth_granted_at IS NULL AND last_verified_at IS NOT NULL AND last_verified_at < ?)
           )
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .bind(platformUserId, cutoff.seconds, cutoff.timestamp, limit)
      .all<ConnectionRow>();
    return results.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      revocationVersion: row.revocation_version,
    }));
  }

  async prepareConnectionDeletion(
    connection: MetaLifecycleConnection,
    platformUserId: string,
    issuedAt: number,
  ): Promise<boolean> {
    platformIdentifier(platformUserId);
    const now = this.#now().toISOString();
    const cutoff = lifecycleCutoff(issuedAt);
    const update = await this.#db
      .prepare(
        `UPDATE threads_connections
         SET status = 'revoking'
         WHERE id = ? AND tenant_id = ? AND connection_mode = 'meta_oauth'
           AND platform_user_id = ?
           AND (
             (oauth_granted_at IS NOT NULL AND oauth_granted_at < ?) OR
             (oauth_granted_at IS NULL AND last_verified_at IS NOT NULL AND last_verified_at < ?)
           )`,
      )
      .bind(
        connection.id,
        connection.tenantId,
        platformUserId,
        cutoff.seconds,
        cutoff.timestamp,
      )
      .run();
    if (update.meta.changes !== 1) return false;

    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE schedule_preferences
           SET enabled = 0, next_run_at = NULL, lease_until = NULL, lease_token = NULL
           WHERE connection_id = ?`,
        )
        .bind(connection.id),
      this.#db
        .prepare(
          `UPDATE jobs
           SET status = CASE WHEN status = 'running' THEN 'needs_review' ELSE 'stopped' END,
               phase = CASE WHEN status = 'running' THEN 'needs_review' ELSE 'stopped' END,
               finished_at = ?
           WHERE tenant_id = ? AND connection_id = ? AND status IN ('received', 'running')`,
        )
        .bind(now, connection.tenantId, connection.id),
      this.#db
        .prepare(
          `UPDATE approvals
           SET status = CASE WHEN status = 'consuming' THEN 'needs_review' ELSE 'revoked' END
           WHERE tenant_id = ? AND connection_id = ?
             AND status IN ('draft', 'awaiting_reauth', 'issued', 'consuming')`,
        )
        .bind(connection.tenantId, connection.id),
      this.#db
        .prepare(
          `UPDATE browser_handoffs SET status = 'terminated', terminated_at = ?
           WHERE tenant_id = ? AND connection_id = ?
             AND status IN ('created', 'exchanged', 'active')`,
        )
        .bind(now, connection.tenantId, connection.id),
      this.#db.prepare('DELETE FROM oauth_attempts WHERE connection_id = ?').bind(connection.id),
    ]);
    return true;
  }

  async listEvidenceBatch(
    connection: MetaLifecycleConnection,
    limit = 100,
  ): Promise<MetaLifecycleEvidence[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Meta lifecycle evidence limit must be between 1 and 1000');
    }
    const { results } = await this.#db
      .prepare(
        `SELECT id, r2_key
         FROM evidence_objects
         WHERE tenant_id = ? AND connection_id = ? AND deleted_at IS NULL
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .bind(connection.tenantId, connection.id, limit)
      .all<EvidenceRow>();
    return results.map((row) => ({ id: row.id, key: row.r2_key }));
  }

  async markEvidenceDeleted(
    connection: MetaLifecycleConnection,
    evidenceIds: readonly string[],
  ): Promise<number> {
    if (evidenceIds.length === 0) return 0;
    if (evidenceIds.length > 1000) throw new RangeError('Too many evidence records');
    const uniqueEvidenceIds = [...new Set(evidenceIds)];
    for (const evidenceId of uniqueEvidenceIds) {
      boundedOpaqueValue(evidenceId, 'evidence ID');
    }
    const placeholders = uniqueEvidenceIds.map(() => '?').join(', ');
    const result = await this.#db
      .prepare(
        `UPDATE evidence_objects SET deleted_at = COALESCE(deleted_at, ?)
         WHERE tenant_id = ? AND connection_id = ? AND deleted_at IS NULL
           AND id IN (${placeholders})`,
      )
      .bind(
        this.#now().toISOString(),
        connection.tenantId,
        connection.id,
        ...uniqueEvidenceIds,
      )
      .run();
    return result.meta.changes;
  }

  async hardDeleteConnection(connection: MetaLifecycleConnection): Promise<boolean> {
    const eligibility = `EXISTS (
      SELECT 1 FROM threads_connections
      WHERE id = ? AND tenant_id = ? AND status = 'revoking'
        AND NOT EXISTS (
          SELECT 1 FROM evidence_objects
          WHERE tenant_id = ? AND connection_id = ? AND deleted_at IS NULL
        )
    )`;
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `DELETE FROM audit_events
           WHERE tenant_id = ?
             AND (
               connection_id = ? OR job_id IN (
                 SELECT id FROM jobs WHERE tenant_id = ? AND connection_id = ?
               )
             )
             AND ${eligibility}`,
        )
        .bind(
          connection.tenantId,
          connection.id,
          connection.tenantId,
          connection.id,
          connection.id,
          connection.tenantId,
          connection.tenantId,
          connection.id,
        ),
      this.#db
        .prepare(
          `DELETE FROM threads_connections
           WHERE id = ? AND tenant_id = ? AND status = 'revoking'
             AND NOT EXISTS (
               SELECT 1 FROM evidence_objects
               WHERE tenant_id = ? AND connection_id = ? AND deleted_at IS NULL
             )
           RETURNING id`,
        )
        .bind(
          connection.id,
          connection.tenantId,
          connection.tenantId,
          connection.id,
        ),
    ]);
    return results[1].results.some(
      (row) => (row as { id?: unknown }).id === connection.id,
    );
  }

  async completeRequest(requestDigest: string, leaseToken: string): Promise<boolean> {
    boundedOpaqueValue(requestDigest, 'Meta lifecycle request digest');
    boundedOpaqueValue(leaseToken, 'Meta lifecycle lease token');
    const now = this.#now().toISOString();
    const result = await this.#db
      .prepare(
        `UPDATE meta_lifecycle_requests
         SET status = 'completed', platform_user_id = NULL, lease_until = NULL,
             lease_token = NULL, completed_at = COALESCE(completed_at, ?),
             updated_at = CASE WHEN status = 'completed' THEN updated_at ELSE ? END,
             last_error_class = NULL
         WHERE request_digest = ?
           AND ((status = 'processing' AND lease_token = ?) OR status = 'completed')`,
      )
      .bind(now, now, requestDigest, leaseToken)
      .run();
    if (result.meta.changes === 1) return true;
    const completed = await this.#db
      .prepare(
        `SELECT 1 AS completed FROM meta_lifecycle_requests
         WHERE request_digest = ? AND status = 'completed'`,
      )
      .bind(requestDigest)
      .first<{ completed: number }>();
    return completed?.completed === 1;
  }

  async deferRequest(
    requestDigest: string,
    leaseToken: string,
    errorClass: string,
    delaySeconds = 300,
  ): Promise<boolean> {
    boundedOpaqueValue(requestDigest, 'Meta lifecycle request digest');
    boundedOpaqueValue(leaseToken, 'Meta lifecycle lease token');
    boundedOpaqueValue(errorClass, 'Meta lifecycle error class');
    if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 30 || delaySeconds > 86_400) {
      throw new RangeError('Meta lifecycle retry delay must be between 30 and 86400 seconds');
    }
    const now = this.#now();
    const nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
    const result = await this.#db
      .prepare(
        `UPDATE meta_lifecycle_requests
         SET status = 'pending', next_attempt_at = ?, lease_until = NULL, lease_token = NULL,
             updated_at = ?, last_error_class = ?
         WHERE request_digest = ? AND status = 'processing' AND lease_token = ?`,
      )
      .bind(
        nextAttemptAt,
        now.toISOString(),
        errorClass.slice(0, 64),
        requestDigest,
        leaseToken,
      )
      .run();
    return result.meta.changes === 1;
  }

  async statusByConfirmationHash(
    confirmationCodeHash: string,
  ): Promise<'pending' | 'completed' | undefined> {
    boundedOpaqueValue(
      confirmationCodeHash,
      'Meta lifecycle confirmation code hash',
    );
    const row = await this.#db
      .prepare(
        `SELECT status FROM meta_lifecycle_requests
         WHERE kind = 'data_deletion' AND confirmation_code_hash = ? AND expires_at > ?`,
      )
      .bind(confirmationCodeHash, this.#now().toISOString())
      .first<StatusRow>();
    if (!row) return undefined;
    return row.status === 'completed' ? 'completed' : 'pending';
  }

  async purgeExpiredReceipts(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Meta lifecycle receipt purge limit must be between 1 and 1000');
    }
    const result = await this.#db
      .prepare(
        `DELETE FROM meta_lifecycle_requests
         WHERE id IN (
           SELECT id FROM meta_lifecycle_requests
           WHERE status = 'completed' AND expires_at <= ?
           ORDER BY expires_at
           LIMIT ?
         )`,
      )
      .bind(this.#now().toISOString(), limit)
      .run();
    return result.meta.changes;
  }
}
