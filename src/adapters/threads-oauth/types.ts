export interface ThreadsConnectedIdentity {
  platformUserId: string;
  username: string;
  displayName?: string;
  profilePictureUrl?: string;
  biography?: string;
  isVerified?: boolean;
}

export interface ThreadsOAuthCredential {
  accessToken: string;
  tokenType: 'bearer';
  issuedAt: string;
  expiresAt: string;
  scopes: readonly ['threads_basic', 'threads_profile_discovery'];
  identity: ThreadsConnectedIdentity;
}

export interface ThreadsOAuthClient {
  exchangeAuthorizationCode(code: string, redirectUri: string): Promise<ThreadsOAuthCredential>;
}

export type OAuthProviderFailure =
  | 'invalid_grant'
  | 'permission_denied'
  | 'rate_limited'
  | 'temporary_unavailable'
  | 'malformed_response'
  | 'identity_mismatch';

export class OAuthProviderError extends Error {
  readonly reason: OAuthProviderFailure;

  constructor(reason: OAuthProviderFailure) {
    super(`Threads OAuth failed: ${reason}`);
    this.name = 'OAuthProviderError';
    this.reason = reason;
  }
}
