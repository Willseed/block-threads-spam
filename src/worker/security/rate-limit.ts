import type { MiddlewareHandler } from 'hono';

import { D1RateLimiter } from '../../platform/d1/rate-limiter';
import type { AppEnvironment } from '../environment';

interface SensitiveAction {
  action: string;
  limit: number;
  windowSeconds: number;
  connectionId?: string;
}

function classify(method: string, path: string): SensitiveAction | undefined {
  const connectionMatch = /^\/api\/connections\/([^/]+)\//u.exec(path);
  if (method !== 'POST') return undefined;
  if (path === '/api/connections') {
    return { action: 'connection_create', limit: 10, windowSeconds: 3600 };
  }

  const connectionId = connectionMatch?.[1];
  if (path.endsWith('/oauth/start')) {
    return { action: 'oauth_start', limit: 5, windowSeconds: 900, connectionId };
  }
  if (path.endsWith('/refresh')) {
    return { action: 'profile_refresh', limit: 30, windowSeconds: 3600, connectionId };
  }
  if (path.endsWith('/approvals') || path === '/api/handoffs') {
    return { action: 'block_capability', limit: 10, windowSeconds: 900, connectionId };
  }
  if (
    /^\/api\/connections\/[^/]+\/candidates(?:\/generate)?$/u.test(path)
  ) {
    return { action: 'candidate_mutation', limit: 100, windowSeconds: 86400, connectionId };
  }
  return undefined;
}

async function hashScope(secret: string, kind: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${secret}\0${kind}\0${value}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export const rateLimitSensitiveActions: MiddlewareHandler<AppEnvironment> = async (
  context,
  next,
) => {
  const action = classify(context.req.method, context.req.path);
  if (!action) return next();

  const secret = context.env.COORDINATOR_NAMESPACE_KEY;
  if (!secret) {
    return context.json(
      { error: { code: 'service_unavailable', message: '安全限制目前無法驗證。' } },
      503,
    );
  }
  const identity = context.get('identity');
  const tenant = context.get('tenant');
  const scopes = [
    await hashScope(secret, 'user', identity.subject),
    await hashScope(secret, 'tenant', tenant.tenantId),
  ];
  const clientIp = context.req.header('cf-connecting-ip');
  if (clientIp) scopes.push(await hashScope(secret, 'ip', clientIp));
  if (action.connectionId) {
    scopes.push(await hashScope(secret, 'connection', action.connectionId));
  }

  try {
    const decision = await new D1RateLimiter(context.env.DB).consume(action, scopes);
    if (!decision.allowed) {
      return context.json(
        { error: { code: 'rate_limited', message: '要求過於頻繁，請稍後再試。' } },
        429,
        {
          'cache-control': 'private, no-store',
          'retry-after': String(decision.retryAfterSeconds),
        },
      );
    }
  } catch {
    return context.json(
      { error: { code: 'service_unavailable', message: '安全限制目前無法驗證。' } },
      503,
    );
  }
  return next();
};
