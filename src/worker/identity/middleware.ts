import { createMiddleware } from 'hono/factory';

import type { AppEnvironment } from '../environment';
import { CloudflareAccessVerifier } from './cloudflare-access';
import type { IdentityVerifier } from './types';

export function requireIdentity(verifier?: IdentityVerifier) {
  return createMiddleware<AppEnvironment>(async (context, next) => {
    try {
      const selectedVerifier = verifier ?? new CloudflareAccessVerifier(context.env);
      context.set('identity', await selectedVerifier.verify(context.req.raw));
      await next();
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
  });
}
