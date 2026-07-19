import type { AppIdentity } from './identity/types';
import type { ApplicationRepository, TenantContext } from '../platform/d1/repository';

export interface AppBindings {
  DB: D1Database;
  POLICY_AUD?: string;
  TEAM_DOMAIN?: string;
}

export interface AppVariables {
  identity: AppIdentity;
  repository: ApplicationRepository;
  tenant: TenantContext;
}

export interface AppEnvironment {
  Bindings: AppBindings;
  Variables: AppVariables;
}
