import type { AppIdentity } from '../../worker/identity/types';
import type { SimilarityAssessment } from '../../domain/similarity';
import type { ProfileLookupFailure, ThreadsPublicProfile } from '../../adapters/threads-profile/types';

export interface TenantContext {
  tenantId: string;
  userId: string;
}

export interface ThreadsConnectionRecord {
  id: string;
  protectedUsername: string;
  platformUserId?: string;
  connectionMode: 'meta_oauth' | 'manual_handoff';
  status:
    | 'awaiting_identity_confirmation'
    | 'connected'
    | 'reauth_required'
    | 'challenge_required'
    | 'revoking'
    | 'revoked';
  createdAt: string;
  revocationVersion: number;
  lastVerifiedAt?: string;
}

export interface OAuthAttemptRecord {
  connectionId: string;
  redirectUri: string;
  jobId: string;
  leaseGeneration: number;
}

export interface NewOAuthAttempt extends OAuthAttemptRecord {
  stateHash: string;
  sessionBinding: string;
  expiresAt: string;
}

export interface CandidateRecord {
  id: string;
  username: string;
  sourceType: 'generated' | 'manual' | 'historical';
  sourceRules: string[];
  reasons: string[];
  status:
    | 'new'
    | 'pending_review'
    | 'watching'
    | 'ignored'
    | 'preparing_block'
    | 'blocking'
    | 'blocked'
    | 'needs_review'
    | 'not_found'
    | 'lookup_unavailable';
  priority: 'low' | 'medium' | 'high';
  firstSeenAt: string;
}

export interface NewCandidate {
  username: string;
  sourceType: CandidateRecord['sourceType'];
  sourceRules: string[];
  reasons: string[];
  priority?: CandidateRecord['priority'];
}

export type CandidateLookupUpdate =
  | {
      status: 'found';
      profile: ThreadsPublicProfile;
      assessment: SimilarityAssessment;
    }
  | { status: 'not_found' }
  | { status: 'unavailable'; reason: ProfileLookupFailure };

export interface ApplicationRepository {
  ensurePersonalTenant(identity: AppIdentity): Promise<TenantContext>;
  createConnection(
    tenant: TenantContext,
    protectedUsername: string,
    connectionMode: ThreadsConnectionRecord['connectionMode'],
  ): Promise<ThreadsConnectionRecord>;
  listConnections(tenant: TenantContext): Promise<ThreadsConnectionRecord[]>;
  getConnection(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<ThreadsConnectionRecord | undefined>;
  createOAuthAttempt(tenant: TenantContext, attempt: NewOAuthAttempt): Promise<void>;
  consumeOAuthAttempt(
    tenant: TenantContext,
    stateHash: string,
    sessionBinding: string,
  ): Promise<OAuthAttemptRecord | undefined>;
  stageOAuthIdentity(
    tenant: TenantContext,
    connectionId: string,
    platformUserId: string,
    username: string,
  ): Promise<ThreadsConnectionRecord>;
  confirmOAuthIdentity(
    tenant: TenantContext,
    connectionId: string,
    expectedUsername: string,
  ): Promise<ThreadsConnectionRecord | undefined>;
  beginConnectionRevocation(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<ThreadsConnectionRecord | undefined>;
  completeConnectionRevocation(
    tenant: TenantContext,
    connectionId: string,
    revocationVersion: number,
    deleteRetainedData: boolean,
  ): Promise<ThreadsConnectionRecord>;
  addCandidate(
    tenant: TenantContext,
    connectionId: string,
    candidate: NewCandidate,
  ): Promise<CandidateRecord>;
  listCandidates(tenant: TenantContext, connectionId: string): Promise<CandidateRecord[]>;
  getCandidate(
    tenant: TenantContext,
    connectionId: string,
    candidateId: string,
  ): Promise<CandidateRecord | undefined>;
  recordCandidateLookup(
    tenant: TenantContext,
    connectionId: string,
    candidateId: string,
    update: CandidateLookupUpdate,
  ): Promise<CandidateRecord>;
  addGeneratedCandidates(
    tenant: TenantContext,
    connectionId: string,
    candidates: readonly NewCandidate[],
  ): Promise<number>;
}

interface RepositoryOptions {
  idFactory?: () => string;
  now?: () => Date;
}

interface TenantRow {
  tenant_id: string;
  user_id: string;
}

interface ConnectionRow {
  id: string;
  protected_username: string;
  platform_user_id: string | null;
  connection_mode: ThreadsConnectionRecord['connectionMode'];
  status: ThreadsConnectionRecord['status'];
  created_at: string;
  revocation_version: number;
  last_verified_at: string | null;
}

interface OAuthAttemptRow {
  connection_id: string;
  redirect_uri: string;
  job_id: string;
  lease_generation: number;
}

interface CandidateRow {
  id: string;
  username: string;
  source_type: CandidateRecord['sourceType'];
  source_rules_json: string;
  reasons_json: string;
  status: CandidateRecord['status'];
  priority: CandidateRecord['priority'];
  first_seen_at: string;
}

export class TenantAuthorizationError extends Error {
  constructor() {
    super('Resource does not belong to the current tenant');
    this.name = 'TenantAuthorizationError';
  }
}

export class CandidateAlreadyExistsError extends Error {
  constructor() {
    super('Candidate already exists');
    this.name = 'CandidateAlreadyExistsError';
  }
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new TypeError('Stored JSON is not a string array');
  }
  return parsed;
}

function connectionRecord(row: ConnectionRow): ThreadsConnectionRecord {
  return {
    id: row.id,
    protectedUsername: row.protected_username,
    ...(row.platform_user_id ? { platformUserId: row.platform_user_id } : {}),
    connectionMode: row.connection_mode,
    status: row.status,
    createdAt: row.created_at,
    revocationVersion: row.revocation_version,
    ...(row.last_verified_at ? { lastVerifiedAt: row.last_verified_at } : {}),
  };
}

function candidateRecord(row: CandidateRow): CandidateRecord {
  return {
    id: row.id,
    username: row.username,
    sourceType: row.source_type,
    sourceRules: parseStringArray(row.source_rules_json),
    reasons: parseStringArray(row.reasons_json),
    status: row.status,
    priority: row.priority,
    firstSeenAt: row.first_seen_at,
  };
}

export class D1Repository implements ApplicationRepository {
  readonly #db: D1Database;
  readonly #idFactory: () => string;
  readonly #now: () => Date;

  constructor(db: D1Database, options: RepositoryOptions = {}) {
    this.#db = db;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async ensurePersonalTenant(identity: AppIdentity): Promise<TenantContext> {
    const existing = await this.#db
      .prepare(
        `SELECT memberships.tenant_id, users.id AS user_id
         FROM users
         JOIN memberships ON memberships.user_id = users.id
         WHERE users.identity_subject = ? AND memberships.role = 'owner'
         LIMIT 1`,
      )
      .bind(identity.subject)
      .first<TenantRow>();
    if (existing) return { tenantId: existing.tenant_id, userId: existing.user_id };

    const userId = `usr_${this.#idFactory()}`;
    const tenantId = `tnt_${this.#idFactory()}`;
    const auditId = `aud_${this.#idFactory()}`;
    const now = this.#now().toISOString();

    await this.#db.batch([
      this.#db
        .prepare('INSERT INTO users (id, identity_subject, email, created_at) VALUES (?, ?, ?, ?)')
        .bind(userId, identity.subject, identity.email ?? null, now),
      this.#db
        .prepare('INSERT INTO tenants (id, owner_user_id, created_at) VALUES (?, ?, ?)')
        .bind(tenantId, userId, now),
      this.#db
        .prepare(
          `INSERT INTO memberships (tenant_id, user_id, role, created_at)
           VALUES (?, ?, 'owner', ?)`,
        )
        .bind(tenantId, userId, now),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, event_type, metadata_json, created_at)
           VALUES (?, ?, ?, 'tenant.created', '{}', ?)`,
        )
        .bind(auditId, tenantId, userId, now),
    ]);

    return { tenantId, userId };
  }

  async createConnection(
    tenant: TenantContext,
    protectedUsername: string,
    connectionMode: ThreadsConnectionRecord['connectionMode'],
  ): Promise<ThreadsConnectionRecord> {
    const id = `con_${this.#idFactory()}`;
    const auditId = `aud_${this.#idFactory()}`;
    const now = this.#now().toISOString();
    const result = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO threads_connections
             (id, tenant_id, protected_username, connection_mode, status, created_at)
           SELECT ?, ?, ?, ?, 'awaiting_identity_confirmation', ?
           WHERE EXISTS (
             SELECT 1 FROM memberships
             WHERE tenant_id = ? AND user_id = ?
           )`,
        )
        .bind(
          id,
          tenant.tenantId,
          protectedUsername,
          connectionMode,
          now,
          tenant.tenantId,
          tenant.userId,
        ),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref, metadata_json, created_at)
           SELECT ?, ?, ?, ?, 'connection.created', ?, '{}', ?
           WHERE EXISTS (
             SELECT 1 FROM threads_connections WHERE id = ? AND tenant_id = ?
           )`,
        )
        .bind(
          auditId,
          tenant.tenantId,
          tenant.userId,
          id,
          protectedUsername,
          now,
          id,
          tenant.tenantId,
        ),
    ]);

    if (result[0].meta.changes !== 1) throw new TenantAuthorizationError();
    return {
      id,
      protectedUsername,
      connectionMode,
      status: 'awaiting_identity_confirmation',
      createdAt: now,
      revocationVersion: 0,
    };
  }

  async listConnections(tenant: TenantContext): Promise<ThreadsConnectionRecord[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id, protected_username, platform_user_id, connection_mode, status, created_at,
                revocation_version, last_verified_at
         FROM threads_connections
         WHERE tenant_id = ?
           AND EXISTS (
             SELECT 1 FROM memberships
             WHERE tenant_id = ? AND user_id = ?
           )
         ORDER BY created_at, id`,
      )
      .bind(tenant.tenantId, tenant.tenantId, tenant.userId)
      .all<ConnectionRow>();
    return results.map(connectionRecord);
  }

  async getConnection(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<ThreadsConnectionRecord | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT id, protected_username, platform_user_id, connection_mode, status, created_at,
                revocation_version, last_verified_at
         FROM threads_connections
         WHERE id = ? AND tenant_id = ?
           AND EXISTS (
             SELECT 1 FROM memberships
             WHERE tenant_id = ? AND user_id = ?
           )`,
      )
      .bind(connectionId, tenant.tenantId, tenant.tenantId, tenant.userId)
      .first<ConnectionRow>();
    return row ? connectionRecord(row) : undefined;
  }

  async createOAuthAttempt(tenant: TenantContext, attempt: NewOAuthAttempt): Promise<void> {
    const result = await this.#db
      .prepare(
        `INSERT INTO oauth_attempts
           (id, state_hash, tenant_id, user_id, connection_id, session_binding, redirect_uri,
            job_id, lease_generation, expires_at, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM threads_connections
           WHERE id = ? AND tenant_id = ? AND connection_mode = 'meta_oauth'
             AND status NOT IN ('revoking', 'revoked')
         ) AND EXISTS (
           SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
         )`,
      )
      .bind(
        `oat_${this.#idFactory()}`,
        attempt.stateHash,
        tenant.tenantId,
        tenant.userId,
        attempt.connectionId,
        attempt.sessionBinding,
        attempt.redirectUri,
        attempt.jobId,
        attempt.leaseGeneration,
        attempt.expiresAt,
        this.#now().toISOString(),
        attempt.connectionId,
        tenant.tenantId,
        tenant.tenantId,
        tenant.userId,
      )
      .run();
    if (result.meta.changes !== 1) throw new TenantAuthorizationError();
  }

  async consumeOAuthAttempt(
    tenant: TenantContext,
    stateHash: string,
    sessionBinding: string,
  ): Promise<OAuthAttemptRecord | undefined> {
    const now = this.#now().toISOString();
    const row = await this.#db
      .prepare(
        `UPDATE oauth_attempts
         SET consumed_at = ?
         WHERE state_hash = ? AND tenant_id = ? AND user_id = ? AND session_binding = ?
           AND consumed_at IS NULL AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )
         RETURNING connection_id, redirect_uri, job_id, lease_generation`,
      )
      .bind(
        now,
        stateHash,
        tenant.tenantId,
        tenant.userId,
        sessionBinding,
        now,
        tenant.tenantId,
        tenant.userId,
      )
      .first<OAuthAttemptRow>();
    return row
      ? {
          connectionId: row.connection_id,
          redirectUri: row.redirect_uri,
          jobId: row.job_id,
          leaseGeneration: row.lease_generation,
        }
      : undefined;
  }

  async stageOAuthIdentity(
    tenant: TenantContext,
    connectionId: string,
    platformUserId: string,
    username: string,
  ): Promise<ThreadsConnectionRecord> {
    const now = this.#now().toISOString();
    const result = await this.#db
      .prepare(
        `UPDATE threads_connections
         SET platform_user_id = ?, protected_username = ?,
             status = 'awaiting_identity_confirmation', last_verified_at = ?
         WHERE id = ? AND tenant_id = ? AND connection_mode = 'meta_oauth'
           AND status NOT IN ('revoking', 'revoked')
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )`,
      )
      .bind(
        platformUserId,
        username,
        now,
        connectionId,
        tenant.tenantId,
        tenant.tenantId,
        tenant.userId,
      )
      .run();
    if (result.meta.changes !== 1) throw new TenantAuthorizationError();
    const connection = await this.getConnection(tenant, connectionId);
    if (!connection) throw new TenantAuthorizationError();
    return connection;
  }

  async confirmOAuthIdentity(
    tenant: TenantContext,
    connectionId: string,
    expectedUsername: string,
  ): Promise<ThreadsConnectionRecord | undefined> {
    const now = this.#now().toISOString();
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE threads_connections
           SET status = 'connected', last_verified_at = ?
           WHERE id = ? AND tenant_id = ? AND status = 'awaiting_identity_confirmation'
             AND platform_user_id IS NOT NULL AND protected_username = ?
             AND EXISTS (
               SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
             )`,
        )
        .bind(
          now,
          connectionId,
          tenant.tenantId,
          expectedUsername,
          tenant.tenantId,
          tenant.userId,
        ),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref,
              metadata_json, created_at)
           SELECT ?, ?, ?, ?, 'connection.identity_confirmed', ?, '{}', ?
           WHERE EXISTS (
             SELECT 1 FROM threads_connections
             WHERE id = ? AND tenant_id = ? AND status = 'connected'
           )`,
        )
        .bind(
          `aud_${this.#idFactory()}`,
          tenant.tenantId,
          tenant.userId,
          connectionId,
          expectedUsername,
          now,
          connectionId,
          tenant.tenantId,
        ),
    ]);
    if (results[0].meta.changes !== 1) return undefined;
    return this.getConnection(tenant, connectionId);
  }

  async beginConnectionRevocation(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<ThreadsConnectionRecord | undefined> {
    const connection = await this.getConnection(tenant, connectionId);
    if (!connection) return undefined;
    if (connection.status === 'revoked') return connection;
    const now = this.#now().toISOString();
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE threads_connections SET status = 'revoking'
           WHERE id = ? AND tenant_id = ? AND status != 'revoked'
             AND EXISTS (
               SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
             )`,
        )
        .bind(connectionId, tenant.tenantId, tenant.tenantId, tenant.userId),
      this.#db
        .prepare(
          `UPDATE schedule_preferences SET enabled = 0, next_run_at = NULL, lease_until = NULL
           WHERE connection_id = ?`,
        )
        .bind(connectionId),
      this.#db
        .prepare(
          `UPDATE jobs
           SET status = CASE WHEN status = 'running' THEN 'needs_review' ELSE 'stopped' END,
               phase = CASE WHEN status = 'running' THEN 'needs_review' ELSE 'stopped' END,
               finished_at = ?
           WHERE tenant_id = ? AND connection_id = ? AND status IN ('received', 'running')`,
        )
        .bind(now, tenant.tenantId, connectionId),
      this.#db
        .prepare(
          `UPDATE approvals
           SET status = CASE WHEN status = 'consuming' THEN 'needs_review' ELSE 'revoked' END
           WHERE tenant_id = ? AND connection_id = ?
             AND status IN ('draft', 'awaiting_reauth', 'issued', 'consuming')`,
        )
        .bind(tenant.tenantId, connectionId),
    ]);
    if (results[0].meta.changes !== 1) return undefined;
    return this.getConnection(tenant, connectionId);
  }

  async completeConnectionRevocation(
    tenant: TenantContext,
    connectionId: string,
    revocationVersion: number,
    deleteRetainedData: boolean,
  ): Promise<ThreadsConnectionRecord> {
    if (!Number.isSafeInteger(revocationVersion) || revocationVersion <= 0) {
      throw new TypeError('Invalid revocation version');
    }
    const now = this.#now().toISOString();
    const statements: D1PreparedStatement[] = [
      this.#db
        .prepare(
          `UPDATE threads_connections
           SET status = 'revoked', revocation_version = ?, revoked_at = ?
           WHERE id = ? AND tenant_id = ? AND status IN ('revoking', 'revoked')
             AND revocation_version <= ?
             AND EXISTS (
               SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
             )`,
        )
        .bind(
          revocationVersion,
          now,
          connectionId,
          tenant.tenantId,
          revocationVersion,
          tenant.tenantId,
          tenant.userId,
        ),
      this.#db.prepare('DELETE FROM oauth_attempts WHERE connection_id = ?').bind(connectionId),
      this.#db.prepare('DELETE FROM schedule_preferences WHERE connection_id = ?').bind(connectionId),
    ];
    if (deleteRetainedData) {
      statements.push(
        this.#db
          .prepare(
            `UPDATE evidence_objects SET deleted_at = COALESCE(deleted_at, ?)
             WHERE tenant_id = ? AND connection_id = ?`,
          )
          .bind(now, tenant.tenantId, connectionId),
        this.#db
          .prepare('DELETE FROM candidates WHERE tenant_id = ? AND connection_id = ?')
          .bind(tenant.tenantId, connectionId),
      );
    }
    statements.push(
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref,
              metadata_json, created_at)
           SELECT ?, ?, ?, ?, 'connection.revoked', protected_username, ?, ?
           FROM threads_connections WHERE id = ? AND tenant_id = ? AND status = 'revoked'`,
        )
        .bind(
          `aud_${this.#idFactory()}`,
          tenant.tenantId,
          tenant.userId,
          connectionId,
          JSON.stringify({ retainedDataDeleted: deleteRetainedData }),
          now,
          connectionId,
          tenant.tenantId,
        ),
    );
    const results = await this.#db.batch(statements);
    if (results[0].meta.changes !== 1) throw new TenantAuthorizationError();
    const connection = await this.getConnection(tenant, connectionId);
    if (!connection) throw new TenantAuthorizationError();
    return connection;
  }

  async addCandidate(
    tenant: TenantContext,
    connectionId: string,
    candidate: NewCandidate,
  ): Promise<CandidateRecord> {
    const id = `can_${this.#idFactory()}`;
    const auditId = `aud_${this.#idFactory()}`;
    const now = this.#now().toISOString();
    const priority = candidate.priority ?? 'low';
    const normalizedUsername = candidate.username.toLocaleLowerCase('en-US');
    const result = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO candidates
             (id, tenant_id, connection_id, username, normalized_username, source_type,
              source_rules_json, reasons_json, status, priority, first_seen_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM threads_connections
             WHERE id = ? AND tenant_id = ? AND status != 'revoked'
           ) AND EXISTS (
             SELECT 1 FROM memberships
             WHERE tenant_id = ? AND user_id = ?
           )
           ON CONFLICT(connection_id, normalized_username) DO NOTHING`,
        )
        .bind(
          id,
          tenant.tenantId,
          connectionId,
          candidate.username,
          normalizedUsername,
          candidate.sourceType,
          JSON.stringify(candidate.sourceRules),
          JSON.stringify(candidate.reasons),
          priority,
          now,
          connectionId,
          tenant.tenantId,
          tenant.tenantId,
          tenant.userId,
        ),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref, metadata_json, created_at)
           SELECT ?, ?, ?, ?, 'candidate.added', ?, '{}', ?
           WHERE EXISTS (SELECT 1 FROM candidates WHERE id = ? AND tenant_id = ?)`,
        )
        .bind(
          auditId,
          tenant.tenantId,
          tenant.userId,
          connectionId,
          normalizedUsername,
          now,
          id,
          tenant.tenantId,
        ),
    ]);

    if (result[0].meta.changes !== 1) {
      const existing = await this.#db
        .prepare(
          `SELECT 1 FROM candidates
           WHERE tenant_id = ? AND connection_id = ? AND normalized_username = ?`,
        )
        .bind(tenant.tenantId, connectionId, normalizedUsername)
        .first();
      if (existing) throw new CandidateAlreadyExistsError();
      throw new TenantAuthorizationError();
    }
    return {
      id,
      username: candidate.username,
      sourceType: candidate.sourceType,
      sourceRules: candidate.sourceRules,
      reasons: candidate.reasons,
      status: 'new',
      priority,
      firstSeenAt: now,
    };
  }

  async listCandidates(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<CandidateRecord[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id, username, source_type, source_rules_json, reasons_json, status, priority, first_seen_at
         FROM candidates
         WHERE tenant_id = ? AND connection_id = ?
           AND EXISTS (
             SELECT 1 FROM memberships
             WHERE tenant_id = ? AND user_id = ?
           )
         ORDER BY first_seen_at, id`,
      )
      .bind(tenant.tenantId, connectionId, tenant.tenantId, tenant.userId)
      .all<CandidateRow>();
    return results.map(candidateRecord);
  }

  async getCandidate(
    tenant: TenantContext,
    connectionId: string,
    candidateId: string,
  ): Promise<CandidateRecord | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT id, username, source_type, source_rules_json, reasons_json, status, priority,
                first_seen_at
         FROM candidates
         WHERE id = ? AND tenant_id = ? AND connection_id = ?
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )`,
      )
      .bind(candidateId, tenant.tenantId, connectionId, tenant.tenantId, tenant.userId)
      .first<CandidateRow>();
    return row ? candidateRecord(row) : undefined;
  }

  async recordCandidateLookup(
    tenant: TenantContext,
    connectionId: string,
    candidateId: string,
    update: CandidateLookupUpdate,
  ): Promise<CandidateRecord> {
    if (!(await this.getCandidate(tenant, connectionId, candidateId))) {
      throw new TenantAuthorizationError();
    }
    const now = this.#now().toISOString();
    const auditId = `aud_${this.#idFactory()}`;
    const statements: D1PreparedStatement[] = [];

    if (update.status === 'found') {
      const snapshotId = `snp_${this.#idFactory()}`;
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO candidate_snapshots
               (id, candidate_id, source, username, display_name, biography_excerpt,
                similarity_reasons_json, checked_at)
             SELECT ?, id, 'meta_api', ?, ?, ?, ?, ?
             FROM candidates
             WHERE id = ? AND tenant_id = ? AND connection_id = ?`,
          )
          .bind(
            snapshotId,
            update.profile.username,
            update.profile.displayName ?? null,
            update.profile.biography?.slice(0, 500) ?? null,
            JSON.stringify([
              ...update.assessment.signals.map(({ explanation }) => explanation),
              update.assessment.disclaimer,
            ]),
            now,
            candidateId,
            tenant.tenantId,
            connectionId,
          ),
        this.#db
          .prepare(
            `UPDATE candidates
             SET current_snapshot_id = ?, last_checked_at = ?, priority = ?,
                 status = CASE
                   WHEN status IN ('new', 'pending_review', 'not_found', 'lookup_unavailable')
                   THEN 'pending_review'
                   ELSE status
                 END
             WHERE id = ? AND tenant_id = ? AND connection_id = ?`,
          )
          .bind(
            snapshotId,
            now,
            update.assessment.priority,
            candidateId,
            tenant.tenantId,
            connectionId,
          ),
      );
    } else {
      const nextStatus = update.status === 'not_found' ? 'not_found' : 'lookup_unavailable';
      statements.push(
        this.#db
          .prepare(
            `UPDATE candidates
             SET last_checked_at = ?,
                 status = CASE
                   WHEN status IN ('new', 'pending_review', 'not_found', 'lookup_unavailable')
                   THEN ?
                   ELSE status
                 END
             WHERE id = ? AND tenant_id = ? AND connection_id = ?`,
          )
          .bind(now, nextStatus, candidateId, tenant.tenantId, connectionId),
      );
    }

    statements.push(
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref,
              metadata_json, created_at)
           SELECT ?, ?, ?, ?, 'candidate.lookup_completed', username, ?, ?
           FROM candidates
           WHERE id = ? AND tenant_id = ? AND connection_id = ?`,
        )
        .bind(
          auditId,
          tenant.tenantId,
          tenant.userId,
          connectionId,
          JSON.stringify({
            result: update.status,
            ...(update.status === 'unavailable' ? { reason: update.reason } : {}),
          }),
          now,
          candidateId,
          tenant.tenantId,
          connectionId,
        ),
    );
    const results = await this.#db.batch(statements);
    if (results[0].meta.changes !== 1) throw new TenantAuthorizationError();
    const candidate = await this.getCandidate(tenant, connectionId, candidateId);
    if (!candidate) throw new TenantAuthorizationError();
    return candidate;
  }

  async addGeneratedCandidates(
    tenant: TenantContext,
    connectionId: string,
    candidates: readonly NewCandidate[],
  ): Promise<number> {
    if (candidates.length === 0) return 0;
    if (candidates.length > 100) throw new RangeError('A candidate snapshot cannot exceed 100');
    if (!(await this.getConnection(tenant, connectionId))) throw new TenantAuthorizationError();

    const now = this.#now().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const candidate of candidates) {
      const id = `can_${this.#idFactory()}`;
      const normalizedUsername = candidate.username.toLocaleLowerCase('en-US');
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO candidates
               (id, tenant_id, connection_id, username, normalized_username, source_type,
                source_rules_json, reasons_json, status, priority, first_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
             ON CONFLICT(connection_id, normalized_username) DO NOTHING`,
          )
          .bind(
            id,
            tenant.tenantId,
            connectionId,
            candidate.username,
            normalizedUsername,
            candidate.sourceType,
            JSON.stringify(candidate.sourceRules),
            JSON.stringify(candidate.reasons),
            candidate.priority ?? 'low',
            now,
          ),
        this.#db
          .prepare(
            `INSERT INTO audit_events
               (id, tenant_id, actor_user_id, connection_id, event_type, target_ref, metadata_json, created_at)
             SELECT ?, ?, ?, ?, 'candidate.generated', ?, '{}', ?
             WHERE EXISTS (SELECT 1 FROM candidates WHERE id = ? AND tenant_id = ?)`,
          )
          .bind(
            `aud_${this.#idFactory()}`,
            tenant.tenantId,
            tenant.userId,
            connectionId,
            normalizedUsername,
            now,
            id,
            tenant.tenantId,
          ),
      );
    }

    const results = await this.#db.batch(statements);
    return results.reduce(
      (created, result, index) => created + (index % 2 === 0 ? result.meta.changes : 0),
      0,
    );
  }
}
