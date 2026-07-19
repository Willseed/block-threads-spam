import { createMiddleware } from 'hono/factory';

import { D1Repository } from '../../platform/d1/repository';
import type { ApplicationRepository } from '../../platform/d1/repository';
import type { AppBindings, AppEnvironment } from '../environment';

export type RepositoryFactory = (bindings: AppBindings) => ApplicationRepository;

export function requireTenant(repositoryFactory?: RepositoryFactory) {
  return createMiddleware<AppEnvironment>(async (context, next) => {
    let repository: ApplicationRepository;
    let tenant;
    try {
      repository = repositoryFactory?.(context.env) ?? new D1Repository(context.env.DB);
      tenant = await repository.ensurePersonalTenant(context.get('identity'));
    } catch {
      return context.json(
        {
          error: {
            code: 'service_unavailable',
            message: '目前無法載入帳號資料，請稍後再試。',
          },
        },
        503,
      );
    }
    context.set('repository', repository);
    context.set('tenant', tenant);
    await next();
  });
}
