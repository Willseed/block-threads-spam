export interface AppIdentity {
  subject: string;
  email?: string;
  authenticatedAt?: string;
  sessionBinding?: string;
}

export interface IdentityVerifier {
  verify(request: Request): Promise<AppIdentity>;
}

export class AuthenticationError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthenticationError';
  }
}
