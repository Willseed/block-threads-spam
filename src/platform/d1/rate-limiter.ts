export interface RateLimitRule {
  action: string;
  limit: number;
  windowSeconds: number;
}

interface RateLimiterOptions {
  now?: () => Date;
}

interface CountRow {
  request_count: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class D1RateLimiter {
  readonly #db: D1Database;
  readonly #now: () => Date;

  constructor(db: D1Database, options: RateLimiterOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  async consume(rule: RateLimitRule, scopeHashes: string[]): Promise<RateLimitDecision> {
    if (
      !rule.action ||
      !Number.isSafeInteger(rule.limit) ||
      rule.limit < 1 ||
      !Number.isSafeInteger(rule.windowSeconds) ||
      rule.windowSeconds < 1 ||
      scopeHashes.length === 0 ||
      scopeHashes.some((scope) => !/^[a-f0-9]{64}$/u.test(scope))
    ) {
      throw new TypeError('Invalid rate limit rule or scope');
    }

    const now = this.#now();
    const windowMilliseconds = rule.windowSeconds * 1000;
    const windowStart = Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds;
    const expiresAt = new Date(windowStart + windowMilliseconds * 2).toISOString();
    const statements = scopeHashes.map((scopeHash) =>
      this.#db
        .prepare(
          `INSERT INTO rate_limit_windows
             (action, scope_hash, window_start, request_count, expires_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(action, scope_hash, window_start)
           DO UPDATE SET request_count = request_count + 1
           RETURNING request_count`,
        )
        .bind(rule.action, scopeHash, windowStart, expiresAt),
    );
    const results = await this.#db.batch<CountRow>(statements);
    const allowed = results.every(({ results: rows }) => (rows[0]?.request_count ?? rule.limit + 1) <= rule.limit);
    return {
      allowed,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMilliseconds - now.getTime()) / 1000)),
    };
  }

  async purgeExpired(limit = 1000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      throw new RangeError('Rate limit purge limit must be between 1 and 5000');
    }
    const result = await this.#db
      .prepare(
        `DELETE FROM rate_limit_windows
         WHERE rowid IN (
           SELECT rowid FROM rate_limit_windows
           WHERE expires_at <= ?
           ORDER BY expires_at ASC
           LIMIT ?
         )`,
      )
      .bind(this.#now().toISOString(), limit)
      .run();
    return result.meta.changes;
  }
}
