import type { AppIdentity } from '../../worker/identity/types';
import type { SimilarityAssessment } from '../../domain/similarity';
import { InvalidStateTransitionError, transitionCandidate } from '../../domain/state-machines';
import type { CandidateEvent } from '../../domain/state-machines';
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
  leaseGeneration: number;
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
  currentSnapshotId?: string;
  targetPlatformId?: string;
  lastCheckedAt?: string;
}

export interface IssuedApproval {
  id: string;
  exactTargetUsername: string;
  targetPlatformId: string;
  evidenceVersion: string;
  expiresAt: string;
}

export interface AuditEventRecord {
  id: string;
  connectionId?: string;
  eventType: string;
  targetRef?: string;
  createdAt: string;
}

export interface SchedulePreferenceRecord {
  enabled: boolean;
  timezone: string;
  frequencyPolicy: 'daily_low_frequency';
  nextRunAt?: string;
  lastRunAt?: string;
}

export interface ConsumedApproval {
  id: string;
  connectionId: string;
  candidateId: string;
  exactTargetUsername: string;
  targetPlatformId: string;
  evidenceVersion: string;
}

export interface NewBrowserHandoff {
  id: string;
  jobId: string;
  approval: ConsumedApproval;
  browserSessionId: string;
  targetId: string;
  exchangeTokenHash: string;
  sessionBinding: string;
  expiresAt: string;
  leaseGeneration: number;
}

export interface ClaimedBrowserHandoff {
  id: string;
  jobId: string;
  connectionId: string;
  candidateId: string;
  approvalId: string;
  browserSessionId: string;
  targetId: string;
  exactTargetUsername: string;
  targetPlatformId: string;
  expiresAt: string;
  leaseGeneration: number;
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
  decideCandidate(
    tenant: TenantContext,
    connectionId: string,
    candidateId: string,
    event: Extract<CandidateEvent, 'mark_watching' | 'ignore'>,
  ): Promise<CandidateRecord>;
  issueApproval(
    tenant: TenantContext,
    connectionId: string,
    candidateId: string,
    exactTargetUsername: string,
    sessionBinding: string,
    nonceHash: string,
    expiresAt: string,
  ): Promise<IssuedApproval>;
  listAuditEvents(
    tenant: TenantContext,
    options?: { connectionId?: string; limit?: number },
  ): Promise<AuditEventRecord[]>;
  getSchedulePreference(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<SchedulePreferenceRecord | undefined>;
  updateSchedulePreference(
    tenant: TenantContext,
    connectionId: string,
    enabled: boolean,
    timezone: string,
  ): Promise<SchedulePreferenceRecord>;
  consumeApproval(
    tenant: TenantContext,
    approvalId: string,
    nonceHash: string,
    sessionBinding: string,
  ): Promise<ConsumedApproval | undefined>;
  createBrowserHandoff(tenant: TenantContext, input: NewBrowserHandoff): Promise<void>;
  claimBrowserHandoff(
    tenant: TenantContext,
    handoffId: string,
    exchangeTokenHash: string,
    sessionBinding: string,
  ): Promise<ClaimedBrowserHandoff | undefined>;
  markHandoffCapabilityIssued(
    tenant: TenantContext,
    handoffId: string,
  ): Promise<boolean>;
  getActiveBrowserHandoff(
    tenant: TenantContext,
    handoffId: string,
    sessionBinding: string,
  ): Promise<ClaimedBrowserHandoff | undefined>;
  completeBrowserHandoff(
    tenant: TenantContext,
    handoffId: string,
    outcome: 'confirmed' | 'unknown' | 'target_mismatch',
  ): Promise<boolean>;
  failHandoffBeforeIssue(
    tenant: TenantContext,
    approvalId: string,
    handoffId?: string,
  ): Promise<void>;
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

interface AuditEventRow {
  id: string;
  connection_id: string | null;
  event_type: string;
  target_ref: string | null;
  created_at: string;
}

interface ConsumedApprovalRow {
  id: string;
  connection_id: string;
  candidate_id: string;
  exact_target_username: string;
  target_platform_id: string;
  evidence_version: string;
}

interface BrowserHandoffRow {
  id: string;
  job_id: string;
  connection_id: string;
  candidate_id: string;
  approval_id: string;
  browser_session_id: string;
  target_id: string;
  exact_target_username: string;
  target_platform_id: string;
  expires_at: string;
  lease_generation: number;
}

interface SchedulePreferenceRow {
  enabled: number;
  timezone: string;
  frequency_policy: 'daily_low_frequency';
  next_run_at: string | null;
  last_run_at: string | null;
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
  current_snapshot_id: string | null;
  target_platform_id: string | null;
  last_checked_at: string | null;
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

export class CandidateDecisionConflictError extends Error {
  constructor() {
    super('Candidate state changed before the decision was saved');
    this.name = 'CandidateDecisionConflictError';
  }
}

export class ApprovalPreconditionError extends Error {
  constructor() {
    super('Approval preconditions are not satisfied');
    this.name = 'ApprovalPreconditionError';
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
    ...(row.current_snapshot_id ? { currentSnapshotId: row.current_snapshot_id } : {}),
    ...(row.target_platform_id ? { targetPlatformId: row.target_platform_id } : {}),
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
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
        `SELECT id, username, source_type, source_rules_json, reasons_json, status, priority,
                first_seen_at, current_snapshot_id, last_checked_at,
                (SELECT platform_id FROM candidate_snapshots
                 WHERE id = candidates.current_snapshot_id) AS target_platform_id
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
                first_seen_at, current_snapshot_id, last_checked_at,
                (SELECT platform_id FROM candidate_snapshots
                 WHERE id = candidates.current_snapshot_id) AS target_platform_id
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
               (id, candidate_id, source, platform_id, username, display_name, biography_excerpt,
                similarity_reasons_json, checked_at)
             SELECT ?, id, 'meta_api', ?, ?, ?, ?, ?, ?
             FROM candidates
             WHERE id = ? AND tenant_id = ? AND connection_id = ?`,
          )
          .bind(
            snapshotId,
            update.profile.platformId ?? null,
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

  async decideCandidate(
    tenant: TenantContext,
    connectionId: string,
    candidateId: string,
    event: Extract<CandidateEvent, 'mark_watching' | 'ignore'>,
  ): Promise<CandidateRecord> {
    const candidate = await this.getCandidate(tenant, connectionId, candidateId);
    if (!candidate) throw new TenantAuthorizationError();
    let nextStatus: CandidateRecord['status'];
    try {
      nextStatus = transitionCandidate(candidate.status, event);
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) {
        throw new CandidateDecisionConflictError();
      }
      throw error;
    }
    const now = this.#now().toISOString();
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE candidates SET status = ?
           WHERE id = ? AND tenant_id = ? AND connection_id = ? AND status = ?
             AND EXISTS (
               SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
             )`,
        )
        .bind(
          nextStatus,
          candidateId,
          tenant.tenantId,
          connectionId,
          candidate.status,
          tenant.tenantId,
          tenant.userId,
        ),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref,
              metadata_json, created_at)
           SELECT ?, ?, ?, ?, 'candidate.decision', username, ?, ?
           FROM candidates WHERE id = ? AND tenant_id = ? AND connection_id = ? AND status = ?`,
        )
        .bind(
          `aud_${this.#idFactory()}`,
          tenant.tenantId,
          tenant.userId,
          connectionId,
          JSON.stringify({ event, previousStatus: candidate.status, nextStatus }),
          now,
          candidateId,
          tenant.tenantId,
          connectionId,
          nextStatus,
        ),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      throw new CandidateDecisionConflictError();
    }
    const updated = await this.getCandidate(tenant, connectionId, candidateId);
    if (!updated) throw new TenantAuthorizationError();
    return updated;
  }

  async issueApproval(
    tenant: TenantContext,
    connectionId: string,
    candidateId: string,
    exactTargetUsername: string,
    sessionBinding: string,
    nonceHash: string,
    expiresAt: string,
  ): Promise<IssuedApproval> {
    if (!/^[a-f0-9]{64}$/u.test(sessionBinding) || !/^[a-f0-9]{64}$/u.test(nonceHash)) {
      throw new TypeError('Invalid approval binding');
    }
    const candidate = await this.getCandidate(tenant, connectionId, candidateId);
    if (
      !candidate ||
      candidate.username !== exactTargetUsername ||
      !candidate.currentSnapshotId ||
      !candidate.targetPlatformId ||
      !candidate.lastCheckedAt
    ) {
      throw new ApprovalPreconditionError();
    }
    let nextStatus: CandidateRecord['status'];
    try {
      nextStatus = transitionCandidate(candidate.status, 'prepare_block');
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) throw new ApprovalPreconditionError();
      throw error;
    }
    const expiry = Date.parse(expiresAt);
    const now = this.#now();
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) throw new ApprovalPreconditionError();
    const approvalId = `apr_${this.#idFactory()}`;
    const auditId = `aud_${this.#idFactory()}`;
    const issuedAt = now.toISOString();
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO approvals
             (id, tenant_id, user_id, connection_id, candidate_id, exact_target_username,
              target_platform_id, evidence_version, nonce_hash, status, issued_at, expires_at,
              session_binding)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM candidates
             WHERE id = ? AND tenant_id = ? AND connection_id = ? AND status = ?
               AND current_snapshot_id = ?
           ) AND EXISTS (
             SELECT 1 FROM threads_connections
             WHERE id = ? AND tenant_id = ? AND status = 'connected'
           ) AND NOT EXISTS (
             SELECT 1 FROM approvals
             WHERE tenant_id = ? AND candidate_id = ?
               AND status IN ('issued', 'consuming') AND expires_at > ?
           )`,
        )
        .bind(
          approvalId,
          tenant.tenantId,
          tenant.userId,
          connectionId,
          candidateId,
          exactTargetUsername,
          candidate.targetPlatformId,
          candidate.currentSnapshotId,
          nonceHash,
          issuedAt,
          expiresAt,
          sessionBinding,
          candidateId,
          tenant.tenantId,
          connectionId,
          candidate.status,
          candidate.currentSnapshotId,
          connectionId,
          tenant.tenantId,
          tenant.tenantId,
          candidateId,
          issuedAt,
        ),
      this.#db
        .prepare(
          `UPDATE candidates SET status = ?
           WHERE id = ? AND tenant_id = ? AND connection_id = ? AND status = ?
             AND EXISTS (SELECT 1 FROM approvals WHERE id = ? AND status = 'issued')`,
        )
        .bind(
          nextStatus,
          candidateId,
          tenant.tenantId,
          connectionId,
          candidate.status,
          approvalId,
        ),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref,
              metadata_json, created_at)
           SELECT ?, ?, ?, ?, 'approval.issued', exact_target_username, ?, ?
           FROM approvals WHERE id = ? AND status = 'issued'`,
        )
        .bind(
          auditId,
          tenant.tenantId,
          tenant.userId,
          connectionId,
          JSON.stringify({ candidateId, evidenceVersion: candidate.currentSnapshotId }),
          issuedAt,
          approvalId,
        ),
    ]);
    if (results.some(({ meta }) => meta.changes !== 1)) throw new ApprovalPreconditionError();
    return {
      id: approvalId,
      exactTargetUsername,
      targetPlatformId: candidate.targetPlatformId,
      evidenceVersion: candidate.currentSnapshotId,
      expiresAt,
    };
  }

  async listAuditEvents(
    tenant: TenantContext,
    options: { connectionId?: string; limit?: number } = {},
  ): Promise<AuditEventRecord[]> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Audit event limit must be between 1 and 100');
    }
    const statement = options.connectionId
      ? this.#db
          .prepare(
            `SELECT id, connection_id, event_type, target_ref, created_at
             FROM audit_events
             WHERE tenant_id = ? AND connection_id = ?
               AND EXISTS (
                 SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
               )
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .bind(
            tenant.tenantId,
            options.connectionId,
            tenant.tenantId,
            tenant.userId,
            limit,
          )
      : this.#db
          .prepare(
            `SELECT id, connection_id, event_type, target_ref, created_at
             FROM audit_events
             WHERE tenant_id = ?
               AND EXISTS (
                 SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
               )
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .bind(tenant.tenantId, tenant.tenantId, tenant.userId, limit);
    const { results } = await statement.all<AuditEventRow>();
    return results.map((row) => ({
      id: row.id,
      ...(row.connection_id ? { connectionId: row.connection_id } : {}),
      eventType: row.event_type,
      ...(row.target_ref ? { targetRef: row.target_ref } : {}),
      createdAt: row.created_at,
    }));
  }

  async getSchedulePreference(
    tenant: TenantContext,
    connectionId: string,
  ): Promise<SchedulePreferenceRecord | undefined> {
    if (!(await this.getConnection(tenant, connectionId))) return undefined;
    const row = await this.#db
      .prepare(
        `SELECT enabled, timezone, frequency_policy, next_run_at, last_run_at
         FROM schedule_preferences
         WHERE connection_id = ?
           AND EXISTS (
             SELECT 1 FROM threads_connections
             WHERE id = ? AND tenant_id = ?
           ) AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )`,
      )
      .bind(connectionId, connectionId, tenant.tenantId, tenant.tenantId, tenant.userId)
      .first<SchedulePreferenceRow>();
    if (!row) {
      return { enabled: false, timezone: 'UTC', frequencyPolicy: 'daily_low_frequency' };
    }
    return {
      enabled: row.enabled === 1,
      timezone: row.timezone,
      frequencyPolicy: row.frequency_policy,
      ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
      ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    };
  }

  async updateSchedulePreference(
    tenant: TenantContext,
    connectionId: string,
    enabled: boolean,
    timezone: string,
  ): Promise<SchedulePreferenceRecord> {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    } catch {
      throw new TypeError('Invalid IANA timezone');
    }
    const now = this.#now();
    const nextRunAt = enabled
      ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
      : null;
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO schedule_preferences
             (connection_id, enabled, timezone, frequency_policy, next_run_at)
           SELECT ?, ?, ?, 'daily_low_frequency', ?
           WHERE EXISTS (
             SELECT 1 FROM threads_connections
             WHERE id = ? AND tenant_id = ? AND status = CASE WHEN ? = 1 THEN 'connected' ELSE status END
           ) AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )
           ON CONFLICT(connection_id) DO UPDATE SET
             enabled = excluded.enabled,
             timezone = excluded.timezone,
             frequency_policy = excluded.frequency_policy,
             next_run_at = excluded.next_run_at,
             lease_until = NULL`,
        )
        .bind(
          connectionId,
          enabled ? 1 : 0,
          timezone,
          nextRunAt,
          connectionId,
          tenant.tenantId,
          enabled ? 1 : 0,
          tenant.tenantId,
          tenant.userId,
        ),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref,
              metadata_json, created_at)
           SELECT ?, ?, ?, ?, 'schedule.updated', protected_username, ?, ?
           FROM threads_connections
           WHERE id = ? AND tenant_id = ?
             AND EXISTS (SELECT 1 FROM schedule_preferences WHERE connection_id = ?)`,
        )
        .bind(
          `aud_${this.#idFactory()}`,
          tenant.tenantId,
          tenant.userId,
          connectionId,
          JSON.stringify({ enabled, timezone, frequencyPolicy: 'daily_low_frequency' }),
          now.toISOString(),
          connectionId,
          tenant.tenantId,
          connectionId,
        ),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
      throw new TenantAuthorizationError();
    }
    const preference = await this.getSchedulePreference(tenant, connectionId);
    if (!preference) throw new TenantAuthorizationError();
    return preference;
  }

  async consumeApproval(
    tenant: TenantContext,
    approvalId: string,
    nonceHash: string,
    sessionBinding: string,
  ): Promise<ConsumedApproval | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(nonceHash) || !/^[a-f0-9]{64}$/u.test(sessionBinding)) {
      return undefined;
    }
    const now = this.#now().toISOString();
    const row = await this.#db
      .prepare(
        `UPDATE approvals SET status = 'consuming'
         WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'issued'
           AND nonce_hash = ? AND session_binding = ? AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM threads_connections
             WHERE id = approvals.connection_id AND tenant_id = ? AND status = 'connected'
           )
           AND EXISTS (
             SELECT 1 FROM candidates
             WHERE id = approvals.candidate_id AND tenant_id = ?
               AND connection_id = approvals.connection_id AND status = 'preparing_block'
               AND current_snapshot_id = approvals.evidence_version
           )
         RETURNING id, connection_id, candidate_id, exact_target_username,
                   target_platform_id, evidence_version`,
      )
      .bind(
        approvalId,
        tenant.tenantId,
        tenant.userId,
        nonceHash,
        sessionBinding,
        now,
        tenant.tenantId,
        tenant.tenantId,
      )
      .first<ConsumedApprovalRow>();
    return row
      ? {
          id: row.id,
          connectionId: row.connection_id,
          candidateId: row.candidate_id,
          exactTargetUsername: row.exact_target_username,
          targetPlatformId: row.target_platform_id,
          evidenceVersion: row.evidence_version,
        }
      : undefined;
  }

  async createBrowserHandoff(tenant: TenantContext, input: NewBrowserHandoff): Promise<void> {
    const now = this.#now().toISOString();
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO jobs
             (id, tenant_id, connection_id, job_type, scope_hash, status, phase,
              idempotency_key_hash, created_at, started_at)
           SELECT ?, ?, ?, 'manual_block', ?, 'running', 'connection_verified', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM approvals
             WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'consuming'
           )`,
        )
        .bind(
          input.jobId,
          tenant.tenantId,
          input.approval.connectionId,
          input.approval.id,
          input.approval.id,
          now,
          now,
          input.approval.id,
          tenant.tenantId,
          tenant.userId,
        ),
      this.#db
        .prepare(
          `INSERT INTO browser_handoffs
             (id, tenant_id, connection_id, job_id, browser_session_id, target_id,
              exchange_token_hash, status, expires_at, approval_id, user_id, session_binding,
              exact_target_username, target_platform_id, lease_generation)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND tenant_id = ?)`,
        )
        .bind(
          input.id,
          tenant.tenantId,
          input.approval.connectionId,
          input.jobId,
          input.browserSessionId,
          input.targetId,
          input.exchangeTokenHash,
          input.expiresAt,
          input.approval.id,
          tenant.userId,
          input.sessionBinding,
          input.approval.exactTargetUsername,
          input.approval.targetPlatformId,
          input.leaseGeneration,
          input.jobId,
          tenant.tenantId,
        ),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, job_id, event_type, target_ref,
              metadata_json, created_at)
           SELECT ?, ?, ?, ?, ?, 'handoff.created', ?, '{}', ?
           WHERE EXISTS (SELECT 1 FROM browser_handoffs WHERE id = ? AND tenant_id = ?)`,
        )
        .bind(
          `aud_${this.#idFactory()}`,
          tenant.tenantId,
          tenant.userId,
          input.approval.connectionId,
          input.jobId,
          input.approval.exactTargetUsername,
          now,
          input.id,
          tenant.tenantId,
        ),
    ]);
    if (results.some(({ meta }) => meta.changes !== 1)) {
      throw new ApprovalPreconditionError();
    }
  }

  async claimBrowserHandoff(
    tenant: TenantContext,
    handoffId: string,
    exchangeTokenHash: string,
    sessionBinding: string,
  ): Promise<ClaimedBrowserHandoff | undefined> {
    const now = this.#now().toISOString();
    const row = await this.#db
      .prepare(
        `UPDATE browser_handoffs SET status = 'exchanged', exchanged_at = ?
         WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'created'
           AND exchange_token_hash = ? AND session_binding = ? AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )
         RETURNING id, job_id, connection_id,
           (SELECT candidate_id FROM approvals WHERE id = browser_handoffs.approval_id) AS candidate_id,
           approval_id, browser_session_id, target_id, exact_target_username,
           target_platform_id, expires_at, lease_generation`,
      )
      .bind(
        now,
        handoffId,
        tenant.tenantId,
        tenant.userId,
        exchangeTokenHash,
        sessionBinding,
        now,
        tenant.tenantId,
        tenant.userId,
      )
      .first<BrowserHandoffRow>();
    return row
      ? {
          id: row.id,
          jobId: row.job_id,
          connectionId: row.connection_id,
          candidateId: row.candidate_id,
          approvalId: row.approval_id,
          browserSessionId: row.browser_session_id,
          targetId: row.target_id,
          exactTargetUsername: row.exact_target_username,
          targetPlatformId: row.target_platform_id,
          expiresAt: row.expires_at,
          leaseGeneration: row.lease_generation,
        }
      : undefined;
  }

  async markHandoffCapabilityIssued(
    tenant: TenantContext,
    handoffId: string,
  ): Promise<boolean> {
    const now = this.#now().toISOString();
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE browser_handoffs
           SET status = 'active', capability_issued_at = ?
           WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'exchanged'`,
        )
        .bind(now, handoffId, tenant.tenantId, tenant.userId),
      this.#db
        .prepare(
          `UPDATE candidates SET status = 'blocking'
           WHERE id = (
             SELECT approvals.candidate_id FROM approvals
             JOIN browser_handoffs ON browser_handoffs.approval_id = approvals.id
             WHERE browser_handoffs.id = ? AND browser_handoffs.tenant_id = ?
           ) AND tenant_id = ? AND status = 'preparing_block'`,
        )
        .bind(handoffId, tenant.tenantId, tenant.tenantId),
    ]);
    return results.every(({ meta }) => meta.changes === 1);
  }

  async getActiveBrowserHandoff(
    tenant: TenantContext,
    handoffId: string,
    sessionBinding: string,
  ): Promise<ClaimedBrowserHandoff | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(sessionBinding)) return undefined;
    const row = await this.#db
      .prepare(
        `SELECT id, job_id, connection_id,
           (SELECT candidate_id FROM approvals WHERE id = browser_handoffs.approval_id) AS candidate_id,
           approval_id, browser_session_id, target_id, exact_target_username,
           target_platform_id, expires_at, lease_generation
         FROM browser_handoffs
         WHERE id = ? AND tenant_id = ? AND user_id = ? AND session_binding = ?
           AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )`,
      )
      .bind(
        handoffId,
        tenant.tenantId,
        tenant.userId,
        sessionBinding,
        tenant.tenantId,
        tenant.userId,
      )
      .first<BrowserHandoffRow>();
    return row
      ? {
          id: row.id,
          jobId: row.job_id,
          connectionId: row.connection_id,
          candidateId: row.candidate_id,
          approvalId: row.approval_id,
          browserSessionId: row.browser_session_id,
          targetId: row.target_id,
          exactTargetUsername: row.exact_target_username,
          targetPlatformId: row.target_platform_id,
          expiresAt: row.expires_at,
          leaseGeneration: row.lease_generation,
        }
      : undefined;
  }

  async completeBrowserHandoff(
    tenant: TenantContext,
    handoffId: string,
    outcome: 'confirmed' | 'unknown' | 'target_mismatch',
  ): Promise<boolean> {
    const now = this.#now().toISOString();
    const confirmed = outcome === 'confirmed';
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE browser_handoffs
           SET status = ?, terminated_at = ?
           WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'active'`,
        )
        .bind(confirmed ? 'completed' : 'terminated', now, handoffId, tenant.tenantId, tenant.userId),
      this.#db
        .prepare(
          `UPDATE approvals
           SET status = ?, consumed_at = ?
           WHERE id = (
             SELECT approval_id FROM browser_handoffs WHERE id = ? AND tenant_id = ?
           ) AND tenant_id = ? AND user_id = ? AND status = 'consuming'`,
        )
        .bind(confirmed ? 'consumed' : 'needs_review', now, handoffId, tenant.tenantId, tenant.tenantId, tenant.userId),
      this.#db
        .prepare(
          `UPDATE candidates
           SET status = ?
           WHERE id = (
             SELECT approvals.candidate_id FROM approvals
             JOIN browser_handoffs ON browser_handoffs.approval_id = approvals.id
             WHERE browser_handoffs.id = ? AND browser_handoffs.tenant_id = ?
           ) AND tenant_id = ? AND status = 'blocking'`,
        )
        .bind(confirmed ? 'blocked' : 'needs_review', handoffId, tenant.tenantId, tenant.tenantId),
      this.#db
        .prepare(
          `UPDATE jobs SET status = ?, phase = ?, finished_at = ?
           WHERE id = (
             SELECT job_id FROM browser_handoffs WHERE id = ? AND tenant_id = ?
           ) AND tenant_id = ? AND status = 'running'`,
        )
        .bind(
          confirmed ? 'succeeded' : 'needs_review',
          confirmed ? 'succeeded' : 'needs_review',
          now,
          handoffId,
          tenant.tenantId,
          tenant.tenantId,
        ),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, job_id, event_type, target_ref,
              metadata_json, created_at)
           SELECT ?, ?, ?, connection_id, job_id, 'handoff.result', exact_target_username, ?, ?
           FROM browser_handoffs WHERE id = ? AND tenant_id = ?
             AND status IN ('completed', 'terminated')`,
        )
        .bind(
          `aud_${this.#idFactory()}`,
          tenant.tenantId,
          tenant.userId,
          JSON.stringify({ outcome }),
          now,
          handoffId,
          tenant.tenantId,
        ),
    ]);
    return results.every(({ meta }) => meta.changes === 1);
  }

  async failHandoffBeforeIssue(
    tenant: TenantContext,
    approvalId: string,
    handoffId?: string,
  ): Promise<void> {
    const now = this.#now().toISOString();
    await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE approvals SET status = 'revoked'
           WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'consuming'`,
        )
        .bind(approvalId, tenant.tenantId, tenant.userId),
      this.#db
        .prepare(
          `UPDATE candidates SET status = 'pending_review'
           WHERE id = (SELECT candidate_id FROM approvals WHERE id = ? AND tenant_id = ?)
             AND tenant_id = ? AND status = 'preparing_block'`,
        )
        .bind(approvalId, tenant.tenantId, tenant.tenantId),
      this.#db
        .prepare(
          `UPDATE browser_handoffs SET status = 'cancelled', terminated_at = ?
           WHERE id = ? AND tenant_id = ? AND status IN ('created', 'exchanged')`,
        )
        .bind(now, handoffId ?? '', tenant.tenantId),
      this.#db
        .prepare(
          `UPDATE jobs SET status = 'stopped', phase = 'stopped', finished_at = ?
           WHERE id = (SELECT job_id FROM browser_handoffs WHERE id = ? AND tenant_id = ?)
             AND tenant_id = ? AND status = 'running'`,
        )
        .bind(now, handoffId ?? '', tenant.tenantId, tenant.tenantId),
    ]);
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
