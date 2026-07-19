import { createMiddleware } from 'hono/factory';

import type { AppEnvironment } from '../environment';

const DEFAULT_MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_MILLISECONDS = 60_000;

function maxAgeSeconds(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_AGE_SECONDS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 60 && parsed <= 3600
    ? parsed
    : DEFAULT_MAX_AGE_SECONDS;
}

export function hasRecentAuthentication(
  authenticatedAt: string | undefined,
  maximumAgeSeconds: number,
  now = Date.now(),
): boolean {
  if (!authenticatedAt) return false;
  const timestamp = Date.parse(authenticatedAt);
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= -CLOCK_SKEW_MILLISECONDS && age <= maximumAgeSeconds * 1000;
}

export const requireRecentAuthentication = createMiddleware<AppEnvironment>(async (context, next) => {
  if (
    !hasRecentAuthentication(
      context.get('identity').authenticatedAt,
      maxAgeSeconds(context.env.REAUTH_MAX_AGE_SECONDS),
    )
  ) {
    return context.json(
      {
        error: {
          code: 'reauthentication_required',
          message: '請先完成近期身分再驗證。',
        },
      },
      403,
    );
  }
  await next();
});
