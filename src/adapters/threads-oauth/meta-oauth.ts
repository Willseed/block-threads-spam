import { z } from 'zod';

import { parseUsername } from '../../domain/usernames';
import { OAuthProviderError } from './types';
import type { OAuthProviderFailure, ThreadsOAuthClient, ThreadsOAuthCredential } from './types';

const shortTokenSchema = z.object({
  access_token: z.string().min(1),
  user_id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
});

const longTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().transform((value) => value.toLocaleLowerCase('en-US')),
  expires_in: z.number().int().positive(),
});

const identitySchema = z.object({
  id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
  username: z.string(),
  name: z.string().optional(),
  threads_profile_picture_url: z.url().optional(),
  threads_biography: z.string().optional(),
  is_verified: z.boolean().optional(),
});

const errorSchema = z.object({
  error: z.object({ code: z.number().int().optional() }),
});

export interface MetaThreadsOAuthOptions {
  appId: string;
  appSecret: string;
  apiVersion?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
}

export function buildMetaThreadsAuthorizationUrl(
  appId: string,
  redirectUri: string,
  state: string,
): string {
  if (!appId || !state || state.length > 128) throw new TypeError('Invalid OAuth request');
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:') throw new TypeError('Invalid OAuth redirect URI');
  const url = new URL('https://threads.com/oauth/authorize');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirect.toString());
  url.searchParams.set('scope', 'threads_basic,threads_profile_discovery');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

function providerFailure(status: number, body: unknown): OAuthProviderFailure {
  const parsed = errorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : undefined;
  if (status === 400 || code === 100) return 'invalid_grant';
  if (status === 401 || status === 403 || code === 10 || code === 190 || code === 200) {
    return 'permission_denied';
  }
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
    return 'rate_limited';
  }
  return 'temporary_unavailable';
}

export class MetaThreadsOAuthClient implements ThreadsOAuthClient {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #apiVersion: string;
  readonly #fetcher: typeof fetch;
  readonly #now: () => Date;

  constructor(options: MetaThreadsOAuthOptions) {
    if (!options.appId || !options.appSecret) throw new TypeError('Threads OAuth is not configured');
    const apiVersion = options.apiVersion ?? 'v1.0';
    if (!/^v\d+\.\d+$/.test(apiVersion)) throw new RangeError('Invalid Meta Graph API version');
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#apiVersion = apiVersion;
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async #request(url: URL, method: 'GET' | 'POST'): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetcher(url, {
        method,
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new OAuthProviderError('temporary_unavailable');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OAuthProviderError(response.ok ? 'malformed_response' : 'temporary_unavailable');
    }
    if (!response.ok) throw new OAuthProviderError(providerFailure(response.status, body));
    return body;
  }

  async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
  ): Promise<ThreadsOAuthCredential> {
    if (!code || code.length > 2048) throw new OAuthProviderError('invalid_grant');

    const shortTokenUrl = new URL('https://graph.threads.net/oauth/access_token');
    shortTokenUrl.searchParams.set('client_id', this.#appId);
    shortTokenUrl.searchParams.set('client_secret', this.#appSecret);
    shortTokenUrl.searchParams.set('code', code);
    shortTokenUrl.searchParams.set('grant_type', 'authorization_code');
    shortTokenUrl.searchParams.set('redirect_uri', redirectUri);
    const shortToken = shortTokenSchema.safeParse(await this.#request(shortTokenUrl, 'POST'));
    if (!shortToken.success) throw new OAuthProviderError('malformed_response');

    const longTokenUrl = new URL('https://graph.threads.net/access_token');
    longTokenUrl.searchParams.set('grant_type', 'th_exchange_token');
    longTokenUrl.searchParams.set('client_secret', this.#appSecret);
    longTokenUrl.searchParams.set('access_token', shortToken.data.access_token);
    const longToken = longTokenSchema.safeParse(await this.#request(longTokenUrl, 'GET'));
    if (!longToken.success || longToken.data.token_type !== 'bearer') {
      throw new OAuthProviderError('malformed_response');
    }

    const identityUrl = new URL(`https://graph.threads.net/${this.#apiVersion}/me`);
    identityUrl.searchParams.set(
      'fields',
      'id,username,name,threads_profile_picture_url,threads_biography,is_verified',
    );
    identityUrl.searchParams.set('access_token', longToken.data.access_token);
    const identity = identitySchema.safeParse(await this.#request(identityUrl, 'GET'));
    if (!identity.success) throw new OAuthProviderError('malformed_response');
    if (identity.data.id !== shortToken.data.user_id) {
      throw new OAuthProviderError('identity_mismatch');
    }

    let username: string;
    try {
      username = parseUsername(identity.data.username);
    } catch {
      throw new OAuthProviderError('malformed_response');
    }

    const issuedAt = this.#now();
    const expiresAt = new Date(issuedAt.getTime() + longToken.data.expires_in * 1000);
    return {
      accessToken: longToken.data.access_token,
      tokenType: 'bearer',
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      scopes: ['threads_basic', 'threads_profile_discovery'],
      identity: {
        platformUserId: identity.data.id,
        username,
        ...(identity.data.name ? { displayName: identity.data.name } : {}),
        ...(identity.data.threads_profile_picture_url
          ? { profilePictureUrl: identity.data.threads_profile_picture_url }
          : {}),
        ...(identity.data.threads_biography
          ? { biography: identity.data.threads_biography }
          : {}),
        ...(identity.data.is_verified === undefined
          ? {}
          : { isVerified: identity.data.is_verified }),
      },
    };
  }
}
