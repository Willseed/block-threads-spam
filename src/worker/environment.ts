import type { AppIdentity } from './identity/types';
import type { ApplicationRepository, TenantContext } from '../platform/d1/repository';
import type { ConnectionCoordinator } from '../durable-objects/connection-coordinator';

export interface AppBindings {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  CONNECTION_COORDINATOR: DurableObjectNamespace<ConnectionCoordinator>;
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
