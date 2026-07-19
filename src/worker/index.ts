import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import type { AppEnvironment } from './environment';
import { requireIdentity } from './identity/middleware';
import type { IdentityVerifier } from './identity/types';
import { connectionRoutes } from './routes/connections';
import { evidenceRoutes } from './routes/evidence';
import { oauthCallbackRoutes, oauthConnectionRoutes } from './routes/oauth';
import type { OAuthClientFactory } from './routes/oauth';
import { requireTenant } from './tenant/middleware';
import type { RepositoryFactory } from './tenant/middleware';

export interface AppDependencies {
  identityVerifier?: IdentityVerifier;
  repositoryFactory?: RepositoryFactory;
  oauthClientFactory?: OAuthClientFactory;
}

export function createApp(dependencies: AppDependencies = {}) {
  const application = new Hono<AppEnvironment>();

  application.use('/api/*', secureHeaders());
  application.use('/auth/*', secureHeaders());

  application.get('/api/health', (context) =>
    context.json({
      service: 'threads-variant-guard',
      status: 'ok',
    }),
  );

  application.use('/api/*', requireIdentity(dependencies.identityVerifier));
  application.use('/api/*', requireTenant(dependencies.repositoryFactory));
  application.use('/auth/*', requireIdentity(dependencies.identityVerifier));
  application.use('/auth/*', requireTenant(dependencies.repositoryFactory));

  application.get('/api/me', (context) => {
    const identity = context.get('identity');
    return context.json({
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.authenticatedAt ? { authenticatedAt: identity.authenticatedAt } : {}),
    });
  });

  application.route('/api/connections', connectionRoutes);
  application.route(
    '/api/connections',
    oauthConnectionRoutes(dependencies.oauthClientFactory),
  );
  application.route('/api/evidence', evidenceRoutes);
  application.route('/auth/threads', oauthCallbackRoutes(dependencies.oauthClientFactory));

  application.notFound((context) => {
    if (context.req.path.startsWith('/api/') || context.req.path.startsWith('/auth/')) {
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
export { ConnectionCoordinator } from '../durable-objects/connection-coordinator';
