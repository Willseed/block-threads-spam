import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { D1RateLimiter } from './rate-limiter';

describe('D1RateLimiter', () => {
  it('enforces every hashed scope and resets at the next fixed window', async () => {
    let now = new Date('2026-07-19T07:00:00.000Z');
    const limiter = new D1RateLimiter(env.DB, { now: () => now });
    const rule = { action: 'test_action', limit: 2, windowSeconds: 60 };
    const scopes = ['a'.repeat(64), 'b'.repeat(64)];

    await expect(limiter.consume(rule, scopes)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume(rule, scopes)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume(rule, scopes)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
    });

    now = new Date('2026-07-19T07:01:00.000Z');
    await expect(limiter.consume(rule, scopes)).resolves.toMatchObject({ allowed: true });
  });

  it('removes expired windows with a bounded maintenance operation', async () => {
    let now = new Date('2026-07-19T07:00:00.000Z');
    const limiter = new D1RateLimiter(env.DB, { now: () => now });
    await limiter.consume(
      { action: 'cleanup_test', limit: 1, windowSeconds: 60 },
      ['c'.repeat(64)],
    );

    now = new Date('2026-07-19T07:02:00.000Z');
    await expect(limiter.purgeExpired(1)).resolves.toBe(1);
    await expect(limiter.purgeExpired(1)).resolves.toBe(0);
    await expect(limiter.purgeExpired(0)).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects unhashed or invalid limiter input', async () => {
    const limiter = new D1RateLimiter(env.DB);
    await expect(
      limiter.consume({ action: 'invalid', limit: 1, windowSeconds: 60 }, ['raw-ip-address']),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
