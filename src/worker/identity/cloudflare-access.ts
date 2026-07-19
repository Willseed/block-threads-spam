import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

import type { AppBindings } from '../environment';
import { AuthenticationError } from './types';
import type { AppIdentity, IdentityVerifier } from './types';

const jwksByTeamDomain = new Map<string, JWTVerifyGetKey>();

function parseTeamDomain(value: string | undefined): URL {
  if (!value) throw new AuthenticationError('Identity provider is not configured');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthenticationError('Identity provider is not configured');
  }

  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new AuthenticationError('Identity provider is not configured');
  }
  return url;
}

function jwksFor(teamDomain: URL): JWTVerifyGetKey {
  const key = teamDomain.origin;
  const existing = jwksByTeamDomain.get(key);
  if (existing) return existing;

  const jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain));
  jwksByTeamDomain.set(key, jwks);
  return jwks;
}

export class CloudflareAccessVerifier implements IdentityVerifier {
  readonly #audience: string;
  readonly #issuer: string;
  readonly #jwks: JWTVerifyGetKey;

  constructor(bindings: AppBindings) {
    const teamDomain = parseTeamDomain(bindings.TEAM_DOMAIN);
    if (!bindings.POLICY_AUD) {
      throw new AuthenticationError('Identity provider is not configured');
    }
    this.#audience = bindings.POLICY_AUD;
    this.#issuer = teamDomain.origin;
    this.#jwks = jwksFor(teamDomain);
  }

  async verify(request: Request): Promise<AppIdentity> {
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) throw new AuthenticationError();

    try {
      const { payload } = await jwtVerify(token, this.#jwks, {
        algorithms: ['RS256'],
        audience: this.#audience,
        issuer: this.#issuer,
      });
      if (!payload.sub) throw new AuthenticationError();

      return {
        subject: payload.sub,
        ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
        ...(payload.iat === undefined
          ? {}
          : { authenticatedAt: new Date(payload.iat * 1000).toISOString() }),
      };
    } catch {
      throw new AuthenticationError();
    }
  }
}
