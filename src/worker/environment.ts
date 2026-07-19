import type { AppIdentity } from './identity/types';

export interface AppBindings {
  POLICY_AUD?: string;
  TEAM_DOMAIN?: string;
}

export interface AppVariables {
  identity: AppIdentity;
}

export interface AppEnvironment {
  Bindings: AppBindings;
  Variables: AppVariables;
}
