import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import type { AppEnvironment } from './environment';
import { requireIdentity } from './identity/middleware';
import type { IdentityVerifier } from './identity/types';

export interface AppDependencies {
  identityVerifier?: IdentityVerifier;
}

export function createApp(dependencies: AppDependencies = {}) {
  const application = new Hono<AppEnvironment>();

  application.use('/api/*', secureHeaders());

  application.get('/api/health', (context) =>
    context.json({
      service: 'threads-variant-guard',
      status: 'ok',
    }),
  );

  application.use('/api/*', requireIdentity(dependencies.identityVerifier));

  application.get('/api/me', (context) => {
    const identity = context.get('identity');
    return context.json({
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.authenticatedAt ? { authenticatedAt: identity.authenticatedAt } : {}),
    });
  });

  application.notFound((context) => {
    if (context.req.path.startsWith('/api/')) {
      return context.json(
        {
          error: {
            code: 'not_found',
            message: '找不到要求的 API。',
          },
        },
        404,
      );
    }
    return context.notFound();
  });

  return application;
}

export const app = createApp();

export default app;
