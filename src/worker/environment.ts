import type { AppIdentity } from './identity/types';
import type { ApplicationRepository, TenantContext } from '../platform/d1/repository';
import type { ConnectionCoordinator } from '../durable-objects/connection-coordinator';

export interface AppBindings {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  CONNECTION_COORDINATOR: DurableObjectNamespace<ConnectionCoordinator>;
  POLICY_AUD?: string;
  TEAM_DOMAIN?: string;
  APP_ORIGIN?: string;
  DEPLOY_ENV?: string;
  FEATURE_AUTOMATED_BLOCK?: string;
  FEATURE_BROWSER_LIVE_VIEW?: string;
  FEATURE_MANUAL_BLOCK_HANDOFF?: string;
  FEATURE_META_PROFILE_LOOKUP?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_GRAPH_API_VERSION?: string;
  SESSION_ENCRYPTION_KEY?: string;
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
