import { Hono } from 'hono';
import type { Context } from 'hono';

import {
  InvalidMetaSignedRequestError,
  MetaSignedRequestConfigurationError,
  verifyMetaSignedRequest,
} from '../../adapters/meta-lifecycle/signed-request';
import {
  metaLifecycleStatus,
  processMetaLifecycleRequest,
  registerMetaLifecycleRequest,
} from '../meta-lifecycle/processor';
import { D1RateLimiter } from '../../platform/d1/rate-limiter';
import type { AppEnvironment } from '../environment';

const CONFIRMATION_CODE_PATTERN = /^[a-f0-9]{64}$/u;

function noStoreHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    pragma: 'no-cache',
  };
}

function invalidCallback(context: Context<AppEnvironment>) {
  return context.json(
    {
      error: {
        code: 'invalid_meta_callback',
        message: '無效的 Meta lifecycle 要求。',
      },
    },
    400,
    noStoreHeaders(),
  );
}

function serviceUnavailable(context: Context<AppEnvironment>) {
  return context.json(
    {
      error: {
        code: 'service_unavailable',
        message: 'Meta lifecycle 服務目前無法使用。',
      },
    },
    503,
    noStoreHeaders(),
  );
}

function rateLimited(context: Context<AppEnvironment>, retryAfterSeconds: number) {
  return context.json(
    {
      error: {
        code: 'rate_limited',
        message: '要求過於頻繁，請稍後再試。',
      },
    },
    429,
    {
      ...noStoreHeaders(),
      'retry-after': String(retryAfterSeconds),
    },
  );
}

async function hmacScope(
  namespaceKey: string | undefined,
  kind: string,
  value: string,
): Promise<string> {
  if (!namespaceKey || new TextEncoder().encode(namespaceKey).byteLength < 32) {
    throw new Error('Meta lifecycle rate limiting is not configured');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(namespaceKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`threads-meta-lifecycle-rate-v1\0${kind}\0${value}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function enforceRateLimit(
  context: Context<AppEnvironment>,
  action: string,
  kind: string,
  value: string,
  limit: number,
): Promise<Response | undefined> {
  try {
    const scope = await hmacScope(context.env.COORDINATOR_NAMESPACE_KEY, kind, value);
    const decision = await new D1RateLimiter(context.env.DB).consume(
      { action, limit, windowSeconds: 3600 },
      [scope],
    );
    return decision.allowed
      ? undefined
      : rateLimited(context, decision.retryAfterSeconds);
  } catch {
    return serviceUnavailable(context);
  }
}

function applicationOrigin(value: string | undefined): URL {
  if (!value) throw new Error('Application origin is not configured');
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Application origin is not configured');
  }
  return origin;
}

async function continueProcessing(
  context: Context<AppEnvironment>,
  requestDigest: string,
): Promise<void> {
  const processing = processMetaLifecycleRequest(context.env, requestDigest).then(
    () => undefined,
    () => undefined,
  );
  try {
    context.executionCtx.waitUntil(processing);
  } catch {
    await processing;
  }
}

async function verifiedCallback(context: Context<AppEnvironment>) {
  try {
    return await verifyMetaSignedRequest(context.req.raw, {
      appId: context.env.META_APP_ID,
      appSecret: context.env.META_APP_SECRET,
    });
  } catch (error) {
    if (error instanceof MetaSignedRequestConfigurationError) {
      return serviceUnavailable(context);
    }
    if (error instanceof InvalidMetaSignedRequestError) return invalidCallback(context);
    return serviceUnavailable(context);
  }
}

export function metaLifecycleRoutes() {
  const routes = new Hono<AppEnvironment>();

  routes.post('/deauthorize', async (context) => {
    const verified = await verifiedCallback(context);
    if (verified instanceof Response) return verified;
    const limited = await enforceRateLimit(
      context,
      'meta_deauthorize',
      'platform-user',
      verified.userId,
      30,
    );
    if (limited) return limited;

    try {
      const receipt = await registerMetaLifecycleRequest(
        context.env,
        'deauthorize',
        verified,
      );
      await continueProcessing(context, receipt.requestDigest);
      return context.body(null, 200, noStoreHeaders());
    } catch {
      return serviceUnavailable(context);
    }
  });

  routes.post('/data-deletion', async (context) => {
    const verified = await verifiedCallback(context);
    if (verified instanceof Response) return verified;
    const limited = await enforceRateLimit(
      context,
      'meta_data_deletion',
      'platform-user',
      verified.userId,
      30,
    );
    if (limited) return limited;

    try {
      const receipt = await registerMetaLifecycleRequest(
        context.env,
        'data_deletion',
        verified,
      );
      if (!receipt.confirmationCode) throw new Error('Missing confirmation code');
      const statusUrl = new URL(
        `/meta/threads/data-deletion/status/${receipt.confirmationCode}`,
        applicationOrigin(context.env.APP_ORIGIN),
      ).toString();
      await continueProcessing(context, receipt.requestDigest);
      return context.json(
        {
          url: statusUrl,
          confirmation_code: receipt.confirmationCode,
        },
        200,
        noStoreHeaders(),
      );
    } catch {
      return serviceUnavailable(context);
    }
  });

  routes.get('/data-deletion/status/:confirmationCode', async (context) => {
    const confirmationCode = context.req.param('confirmationCode');
    if (!CONFIRMATION_CODE_PATTERN.test(confirmationCode)) {
      return context.json(
        { error: { code: 'not_found', message: '找不到資料刪除要求。' } },
        404,
        noStoreHeaders(),
      );
    }

    const clientIp = context.req.header('cf-connecting-ip');
    if (!clientIp) return serviceUnavailable(context);
    const limited = await enforceRateLimit(
      context,
      'meta_deletion_status',
      'client-ip',
      clientIp,
      600,
    );
    if (limited) return limited;

    try {
      const status = await metaLifecycleStatus(context.env, confirmationCode);
      if (!status) {
        return context.json(
          { error: { code: 'not_found', message: '找不到資料刪除要求。' } },
          404,
          noStoreHeaders(),
        );
      }
      return context.json({ status }, 200, noStoreHeaders());
    } catch {
      return serviceUnavailable(context);
    }
  });

  return routes;
}
