import type { ProfileLookupResult } from '../../adapters/threads-profile/types';
import type { CandidateRecord, TenantContext } from './repository';

export interface DueSchedule {
  connectionId: string;
  tenant: TenantContext;
  protectedUsername: string;
  revocationVersion: number;
}

interface DueScheduleRow {
  connection_id: string;
  tenant_id: string;
  user_id: string;
  protected_username: string;
  revocation_version: number;
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

function parseArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return [];
  return parsed;
}

export class SchedulerRepository {
  readonly #db: D1Database;
  readonly #now: () => Date;

  constructor(db: D1Database, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  async claimDueSchedules(limit = 10): Promise<DueSchedule[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new RangeError('Schedule claim limit must be between 1 and 10');
    }
    const now = this.#now();
    const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const leaseToken = crypto.randomUUID();
    await this.#db
      .prepare(
        `UPDATE schedule_preferences
         SET lease_until = ?, lease_token = ?
         WHERE connection_id IN (
           SELECT schedule_preferences.connection_id
           FROM schedule_preferences
           JOIN threads_connections ON threads_connections.id = schedule_preferences.connection_id
           WHERE schedule_preferences.enabled = 1
             AND schedule_preferences.next_run_at <= ?
             AND (schedule_preferences.lease_until IS NULL OR schedule_preferences.lease_until <= ?)
             AND threads_connections.status = 'connected'
           ORDER BY schedule_preferences.next_run_at, schedule_preferences.connection_id
           LIMIT ?
         )`,
      )
      .bind(leaseUntil, leaseToken, now.toISOString(), now.toISOString(), limit)
      .run();
    const { results } = await this.#db
      .prepare(
        `SELECT schedule_preferences.connection_id, threads_connections.tenant_id,
                tenants.owner_user_id AS user_id, threads_connections.protected_username,
                threads_connections.revocation_version
         FROM schedule_preferences
         JOIN threads_connections ON threads_connections.id = schedule_preferences.connection_id
         JOIN tenants ON tenants.id = threads_connections.tenant_id
         WHERE schedule_preferences.lease_token = ? AND schedule_preferences.lease_until = ?
         ORDER BY schedule_preferences.next_run_at, schedule_preferences.connection_id`,
      )
      .bind(leaseToken, leaseUntil)
      .all<DueScheduleRow>();
    return results.map((row) => ({
      connectionId: row.connection_id,
      tenant: { tenantId: row.tenant_id, userId: row.user_id },
      protectedUsername: row.protected_username,
      revocationVersion: row.revocation_version,
    }));
  }

  async nextCandidate(schedule: DueSchedule): Promise<CandidateRecord | undefined> {
    const now = this.#now().toISOString();
    const row = await this.#db
      .prepare(
        `SELECT id, username, source_type, source_rules_json, reasons_json, status, priority,
                first_seen_at
         FROM candidates
         WHERE tenant_id = ? AND connection_id = ?
           AND status IN ('pending_review', 'watching', 'not_found', 'lookup_unavailable')
           AND (next_check_at IS NULL OR next_check_at <= ?)
         ORDER BY COALESCE(last_checked_at, first_seen_at), id
         LIMIT 1`,
      )
      .bind(schedule.tenant.tenantId, schedule.connectionId, now)
      .first<CandidateRow>();
    return row
      ? {
          id: row.id,
          username: row.username,
          sourceType: row.source_type,
          sourceRules: parseArray(row.source_rules_json),
          reasons: parseArray(row.reasons_json),
          status: row.status,
          priority: row.priority,
          firstSeenAt: row.first_seen_at,
        }
      : undefined;
  }

  async deferCandidate(candidateId: string, lookup: ProfileLookupResult): Promise<void> {
    let delay: number;
    switch (lookup.status) {
      case 'not_found':
        delay = 7 * 24 * 60 * 60 * 1000;
        break;
      case 'unavailable':
        delay = lookup.reason === 'rate_limited'
          ? 24 * 60 * 60 * 1000
          : 6 * 60 * 60 * 1000;
        break;
      default:
        delay = 24 * 60 * 60 * 1000;
    }
    await this.#db
      .prepare('UPDATE candidates SET next_check_at = ? WHERE id = ?')
      .bind(new Date(this.#now().getTime() + delay).toISOString(), candidateId)
      .run();
  }

  async finishSchedule(connectionId: string, succeeded: boolean): Promise<void> {
    const now = this.#now();
    const nextDelay = succeeded ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    await this.#db
      .prepare(
        `UPDATE schedule_preferences
         SET last_run_at = CASE WHEN ? = 1 THEN ? ELSE last_run_at END,
             next_run_at = ?, lease_until = NULL, lease_token = NULL
         WHERE connection_id = ?`,
      )
      .bind(
        succeeded ? 1 : 0,
        now.toISOString(),
        new Date(now.getTime() + nextDelay).toISOString(),
        connectionId,
      )
      .run();
  }
}
