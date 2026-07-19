import { describe, expect, it, vi } from 'vitest';

import { MetaThreadsOAuthClient } from './meta-oauth';
import { OAuthProviderError } from './types';

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MetaThreadsOAuthClient', () => {
  it('exchanges a code, upgrades the token and confirms the exact Threads identity', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'short-token', user_id: '12345' }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'long-token', token_type: 'bearer', expires_in: 5_184_000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: '12345',
          username: 'Will.Seed',
          name: 'Will Seed',
          threads_profile_picture_url: 'https://cdn.example/avatar.jpg',
          threads_biography: 'Product studio',
          is_verified: false,
        }),
      );
    const client = new MetaThreadsOAuthClient({
      appId: 'app-id',
      appSecret: 'app-secret',
      fetcher,
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });

    const credential = await client.exchangeAuthorizationCode(
      'single-use-code',
      'https://guard.example/auth/threads/callback',
    );

    expect(credential).toMatchObject({
      accessToken: 'long-token',
      tokenType: 'bearer',
      issuedAt: '2026-07-19T07:00:00.000Z',
      expiresAt: '2026-09-17T07:00:00.000Z',
      scopes: ['threads_basic', 'threads_profile_discovery'],
      identity: { platformUserId: '12345', username: 'will.seed', displayName: 'Will Seed' },
    });

    const requests = fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(requests.map(({ origin, pathname }) => `${origin}${pathname}`)).toEqual([
      'https://graph.threads.net/oauth/access_token',
      'https://graph.threads.net/access_token',
      'https://graph.threads.net/v1.0/me',
    ]);
    expect(requests[0]?.searchParams.get('redirect_uri')).toBe(
      'https://guard.example/auth/threads/callback',
    );
  });

  it('stops when the exchanged user and /me identity differ', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'short-token', user_id: '12345' }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'long-token', token_type: 'bearer', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: '99999', username: 'another_user' }));
    const client = new MetaThreadsOAuthClient({ appId: 'app', appSecret: 'secret', fetcher });

    await expect(
      client.exchangeAuthorizationCode('code', 'https://guard.example/auth/threads/callback'),
    ).rejects.toMatchObject({ reason: 'identity_mismatch' });
  });

  it('returns a safe classification without including code, secret or provider token', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 190, message: 'token=provider-secret-value' } }, 401),
    );
    const client = new MetaThreadsOAuthClient({
      appId: 'app',
      appSecret: 'app-secret-value',
      fetcher,
    });

    let error: unknown;
    try {
      await client.exchangeAuthorizationCode(
        'authorization-code-value',
        'https://guard.example/auth/threads/callback',
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OAuthProviderError);
    expect(String(error)).toBe('OAuthProviderError: Threads OAuth failed: permission_denied');
    expect(String(error)).not.toContain('app-secret-value');
    expect(String(error)).not.toContain('authorization-code-value');
    expect(String(error)).not.toContain('provider-secret-value');
  });
});
