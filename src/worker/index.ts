import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import type { AppEnvironment } from './environment';
import { requireIdentity } from './identity/middleware';
import type { IdentityVerifier } from './identity/types';
import { connectionRoutes } from './routes/connections';
import { activityRoutes } from './routes/activity';
import { evidenceRoutes } from './routes/evidence';
import { oauthCallbackRoutes, oauthConnectionRoutes } from './routes/oauth';
import type { OAuthClientFactory } from './routes/oauth';
import type { BrowserHandoffProvider } from '../adapters/browser-handoff/types';
import { FailClosedBrowserHandoffProvider } from '../adapters/browser-handoff/fail-closed';
import { createHandoffRoutes } from './routes/handoffs';
import { requireTenant } from './tenant/middleware';
import type { RepositoryFactory } from './tenant/middleware';
import { runScheduledScans } from './scheduled';

export interface AppDependencies {
  identityVerifier?: IdentityVerifier;
  repositoryFactory?: RepositoryFactory;
  oauthClientFactory?: OAuthClientFactory;
  browserHandoffProvider?: BrowserHandoffProvider;
}

export function createApp(dependencies: AppDependencies = {}) {
  const application = new Hono<AppEnvironment>();
  const browserHandoffProvider =
    dependencies.browserHandoffProvider ?? new FailClosedBrowserHandoffProvider();

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

  application.get('/api/capabilities', (context) =>
    context.json({
      capabilities: {
        officialProfileLookup: context.env.FEATURE_META_PROFILE_LOOKUP === 'true',
        manualBlockHandoff:
          context.env.FEATURE_MANUAL_BLOCK_HANDOFF === 'true' &&
          context.env.FEATURE_BROWSER_LIVE_VIEW === 'true' &&
          browserHandoffProvider.isAvailable(),
        automatedBlock: false,
      },
    }),
  );

  application.route('/api/connections', connectionRoutes);
  application.route(
    '/api/connections',
    oauthConnectionRoutes(dependencies.oauthClientFactory),
  );
  application.route('/api/evidence', evidenceRoutes);
  application.route('/api/activity', activityRoutes);
  application.route(
    '/api/handoffs',
    createHandoffRoutes(browserHandoffProvider),
  );
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

const worker: ExportedHandler<AppEnvironment['Bindings']> = {
  fetch: app.fetch,
  scheduled(_controller, bindings, executionContext) {
    executionContext.waitUntil(runScheduledScans(bindings));
  },
};

export default worker;
export { ConnectionCoordinator } from '../durable-objects/connection-coordinator';
