import { createMiddleware } from 'hono/factory';

import type { AppEnvironment } from '../environment';
import { CloudflareAccessVerifier } from './cloudflare-access';
import type { IdentityVerifier } from './types';

export function requireIdentity(verifier?: IdentityVerifier) {
  return createMiddleware<AppEnvironment>(async (context, next) => {
    let identity;
    try {
      const selectedVerifier = verifier ?? new CloudflareAccessVerifier(context.env);
      identity = await selectedVerifier.verify(context.req.raw);
    } catch {
      return context.json(
        {
          error: {
            code: 'authentication_required',
            message: '請先登入本服務。',
          },
        },
        401,
      );
    }
    context.set('identity', identity);
    await next();
  });
}
