import { z } from 'zod';

import { parseUsername } from '../../domain/usernames';
import type {
  ProfileLookupRequest,
  ProfileLookupResult,
  ThreadsProfileAdapter,
} from './types';

const profileSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String).optional(),
  username: z.string(),
  name: z.string().optional(),
  biography: z.string().optional(),
  profile_picture_url: z.url().optional(),
  is_verified: z.boolean().optional(),
  follower_count: z.number().int().nonnegative().optional(),
});

const errorSchema = z.object({
  error: z.object({
    code: z.number().int().optional(),
  }),
});

export interface MetaThreadsProfileAdapterOptions {
  apiVersion?: string;
  fetcher?: typeof fetch;
}

function unavailableReason(status: number, body: unknown): ProfileLookupResult {
  const parsedError = errorSchema.safeParse(body);
  const code = parsedError.success ? parsedError.data.error.code : undefined;

  if (status === 404 || code === 100) return { status: 'not_found' };
  if (status === 401 || status === 403 || code === 10 || code === 190 || code === 200) {
    return { status: 'unavailable', reason: 'permission_denied' };
  }
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
    return { status: 'unavailable', reason: 'rate_limited' };
  }
  return { status: 'unavailable', reason: 'temporary_unavailable' };
}

export class MetaThreadsProfileAdapter implements ThreadsProfileAdapter {
  readonly #apiVersion: string;
  readonly #fetcher: typeof fetch;

  constructor(options: MetaThreadsProfileAdapterOptions = {}) {
    const apiVersion = options.apiVersion ?? 'v1.0';
    if (!/^v\d+\.\d+$/.test(apiVersion)) throw new RangeError('Invalid Meta Graph API version');
    this.#apiVersion = apiVersion;
    this.#fetcher = options.fetcher ?? fetch;
  }

  async lookup(request: ProfileLookupRequest): Promise<ProfileLookupResult> {
    const username = parseUsername(request.username);
    if (request.accessToken.length === 0) {
      return { status: 'unavailable', reason: 'permission_denied' };
    }

    const url = new URL(`https://graph.threads.net/${this.#apiVersion}/profile_lookup`);
    url.searchParams.set('username', username);
    url.searchParams.set('access_token', request.accessToken);

    let response: Response;
    try {
      response = await this.#fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch {
      return { status: 'unavailable', reason: 'temporary_unavailable' };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return response.ok
        ? { status: 'unavailable', reason: 'malformed_response' }
        : { status: 'unavailable', reason: 'temporary_unavailable' };
    }

    if (!response.ok) return unavailableReason(response.status, body);

    const parsed = profileSchema.safeParse(body);
    if (!parsed.success) return { status: 'unavailable', reason: 'malformed_response' };

    let returnedUsername: string;
    try {
      returnedUsername = parseUsername(parsed.data.username);
    } catch {
      return { status: 'unavailable', reason: 'malformed_response' };
    }
    if (returnedUsername !== username) {
      return { status: 'unavailable', reason: 'malformed_response' };
    }

    return {
      status: 'found',
      profile: {
        ...(parsed.data.id ? { platformId: parsed.data.id } : {}),
        username: returnedUsername,
        ...(parsed.data.name ? { displayName: parsed.data.name } : {}),
        ...(parsed.data.biography ? { biography: parsed.data.biography } : {}),
        ...(parsed.data.profile_picture_url
          ? { profilePictureUrl: parsed.data.profile_picture_url }
          : {}),
        ...(parsed.data.is_verified === undefined
          ? {}
          : { isVerified: parsed.data.is_verified }),
        ...(parsed.data.follower_count === undefined
          ? {}
          : { followerCount: parsed.data.follower_count }),
      },
    };
  }
}
