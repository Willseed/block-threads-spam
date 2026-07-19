import type { AppIdentity } from '../../worker/identity/types';

export interface TenantContext {
  tenantId: string;
  userId: string;
}

export interface ThreadsConnectionRecord {
  id: string;
  protectedUsername: string;
  connectionMode: 'meta_oauth' | 'manual_handoff';
  status:
    | 'awaiting_identity_confirmation'
    | 'connected'
    | 'reauth_required'
    | 'challenge_required'
    | 'revoking'
    | 'revoked';
  createdAt: string;
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
  addCandidate(
    tenant: TenantContext,
    connectionId: string,
    candidate: NewCandidate,
  ): Promise<CandidateRecord>;
  listCandidates(tenant: TenantContext, connectionId: string): Promise<CandidateRecord[]>;
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
  connection_mode: ThreadsConnectionRecord['connectionMode'];
  status: ThreadsConnectionRecord['status'];
  created_at: string;
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
    connectionMode: row.connection_mode,
    status: row.status,
    createdAt: row.created_at,
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
    };
  }

  async listConnections(tenant: TenantContext): Promise<ThreadsConnectionRecord[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id, protected_username, connection_mode, status, created_at
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
        `SELECT id, protected_username, connection_mode, status, created_at
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
