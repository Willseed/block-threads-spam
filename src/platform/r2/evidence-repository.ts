import { TenantAuthorizationError } from '../d1/repository';
import type { TenantContext } from '../d1/repository';

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  'application/json',
  'image/jpeg',
  'image/png',
  'text/plain',
]);

export interface NewEvidence {
  connectionId: string;
  candidateId?: string;
  jobId?: string;
  evidenceType: 'profile_snapshot' | 'pre_action' | 'post_action' | 'diagnostic';
  source: 'meta_api' | 'manual_handoff' | 'fixture';
  contentType: 'application/json' | 'image/jpeg' | 'image/png' | 'text/plain';
  body: ArrayBuffer | Uint8Array;
  retentionUntil: Date;
}

export interface EvidenceRecord {
  id: string;
  connectionId: string;
  candidateId?: string;
  evidenceType: NewEvidence['evidenceType'];
  contentType: NewEvidence['contentType'];
  byteLength: number;
  sha256: string;
  createdAt: string;
  retentionUntil: string;
}

export interface EvidenceObject extends EvidenceRecord {
  body: ReadableStream;
}

interface EvidenceRow {
  id: string;
  connection_id: string;
  candidate_id: string | null;
  evidence_type: NewEvidence['evidenceType'];
  r2_key: string;
  sha256: string;
  content_type: NewEvidence['contentType'];
  byte_length: number;
  created_at: string;
  retention_until: string;
}

interface EvidenceKeyRow {
  r2_key: string;
}

interface EvidenceRepositoryOptions {
  idFactory?: () => string;
  now?: () => Date;
}

export class InvalidEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEvidenceError';
  }
}

export class EvidenceStorageError extends Error {
  constructor(message = 'Evidence storage is unavailable') {
    super(message);
    this.name = 'EvidenceStorageError';
  }
}

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function evidenceRecord(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
    evidenceType: row.evidence_type,
    contentType: row.content_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    createdAt: row.created_at,
    retentionUntil: row.retention_until,
  };
}

export class R2EvidenceRepository {
  readonly #db: D1Database;
  readonly #bucket: R2Bucket;
  readonly #idFactory: () => string;
  readonly #now: () => Date;

  constructor(db: D1Database, bucket: R2Bucket, options: EvidenceRepositoryOptions = {}) {
    this.#db = db;
    this.#bucket = bucket;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async put(tenant: TenantContext, input: NewEvidence): Promise<EvidenceRecord> {
    const bytes = asBytes(input.body);
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw new InvalidEvidenceError('Unsupported evidence content type');
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_EVIDENCE_BYTES) {
      throw new InvalidEvidenceError('Evidence size is outside the allowed range');
    }
    const now = this.#now();
    if (input.retentionUntil.getTime() <= now.getTime()) {
      throw new InvalidEvidenceError('Evidence retention must end in the future');
    }

    const ownership = await this.#db
      .prepare(
        `SELECT 1
         FROM threads_connections
         WHERE id = ? AND tenant_id = ?
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )
           AND (
             ? IS NULL OR EXISTS (
               SELECT 1 FROM candidates
               WHERE id = ? AND connection_id = threads_connections.id AND tenant_id = ?
             )
           )`,
      )
      .bind(
        input.connectionId,
        tenant.tenantId,
        tenant.tenantId,
        tenant.userId,
        input.candidateId ?? null,
        input.candidateId ?? null,
        tenant.tenantId,
      )
      .first();
    if (!ownership) throw new TenantAuthorizationError();

    const evidenceId = `evd_${this.#idFactory()}`;
    const objectKey = `evidence/${tenant.tenantId}/${input.connectionId}/${this.#idFactory()}`;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = toHex(digest);
    const createdAt = now.toISOString();
    const retentionUntil = input.retentionUntil.toISOString();

    const object = await this.#bucket.put(objectKey, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: input.contentType },
      customMetadata: { evidenceId },
      sha256: digest,
    });
    if (!object) throw new EvidenceStorageError();

    try {
      const result = await this.#db.batch([
        this.#db
          .prepare(
            `INSERT INTO evidence_objects
               (id, tenant_id, connection_id, candidate_id, job_id, evidence_type, r2_key,
                sha256, content_type, byte_length, source, created_at, retention_until)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            evidenceId,
            tenant.tenantId,
            input.connectionId,
            input.candidateId ?? null,
            input.jobId ?? null,
            input.evidenceType,
            objectKey,
            sha256,
            input.contentType,
            bytes.byteLength,
            input.source,
            createdAt,
            retentionUntil,
          ),
        this.#db
          .prepare(
            `INSERT INTO audit_events
               (id, tenant_id, actor_user_id, connection_id, job_id, event_type,
                target_ref, metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, 'evidence.created', ?, ?, ?)`,
          )
          .bind(
            `aud_${this.#idFactory()}`,
            tenant.tenantId,
            tenant.userId,
            input.connectionId,
            input.jobId ?? null,
            evidenceId,
            JSON.stringify({ contentType: input.contentType, byteLength: bytes.byteLength }),
            createdAt,
          ),
      ]);
      if (result[0].meta.changes !== 1) throw new EvidenceStorageError();
    } catch {
      await this.#bucket.delete(objectKey);
      throw new EvidenceStorageError();
    }

    return {
      id: evidenceId,
      connectionId: input.connectionId,
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      evidenceType: input.evidenceType,
      contentType: input.contentType,
      byteLength: bytes.byteLength,
      sha256,
      createdAt,
      retentionUntil,
    };
  }

  async get(tenant: TenantContext, evidenceId: string): Promise<EvidenceObject | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT id, connection_id, candidate_id, evidence_type, r2_key, sha256,
                content_type, byte_length, created_at, retention_until
         FROM evidence_objects
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )`,
      )
      .bind(evidenceId, tenant.tenantId, tenant.tenantId, tenant.userId)
      .first<EvidenceRow>();
    if (!row) return undefined;

    const object = await this.#bucket.get(row.r2_key);
    if (!object) throw new EvidenceStorageError();
    return { ...evidenceRecord(row), body: object.body };
  }

  async delete(tenant: TenantContext, evidenceId: string): Promise<boolean> {
    const row = await this.#db
      .prepare(
        `SELECT id, connection_id, candidate_id, evidence_type, r2_key, sha256,
                content_type, byte_length, created_at, retention_until
         FROM evidence_objects
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )`,
      )
      .bind(evidenceId, tenant.tenantId, tenant.tenantId, tenant.userId)
      .first<EvidenceRow>();
    if (!row) return false;

    await this.#bucket.delete(row.r2_key);
    const now = this.#now().toISOString();
    const result = await this.#db.batch([
      this.#db
        .prepare(
          `UPDATE evidence_objects SET deleted_at = ?
           WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
        )
        .bind(now, evidenceId, tenant.tenantId),
      this.#db
        .prepare(
          `INSERT INTO audit_events
             (id, tenant_id, actor_user_id, connection_id, event_type, target_ref, metadata_json, created_at)
           VALUES (?, ?, ?, ?, 'evidence.deleted', ?, '{}', ?)`,
        )
        .bind(
          `aud_${this.#idFactory()}`,
          tenant.tenantId,
          tenant.userId,
          row.connection_id,
          evidenceId,
          now,
        ),
    ]);
    return result[0].meta.changes === 1;
  }

  async purgeConnection(tenant: TenantContext, connectionId: string): Promise<number> {
    const { results } = await this.#db
      .prepare(
        `SELECT r2_key
         FROM evidence_objects
         WHERE tenant_id = ? AND connection_id = ? AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?
           )`,
      )
      .bind(tenant.tenantId, connectionId, tenant.tenantId, tenant.userId)
      .all<EvidenceKeyRow>();
    const keys = results.map(({ r2_key: key }) => key);
    for (let index = 0; index < keys.length; index += 1000) {
      await this.#bucket.delete(keys.slice(index, index + 1000));
    }
    return keys.length;
  }
}
