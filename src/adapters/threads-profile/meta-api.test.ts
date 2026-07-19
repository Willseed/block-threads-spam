import { describe, expect, it, vi } from 'vitest';

import { FailClosedThreadsProfileAdapter } from './fail-closed';
import { MetaThreadsProfileAdapter } from './meta-api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MetaThreadsProfileAdapter', () => {
  it('looks up one exact username and maps only allowlisted profile fields', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        id: '17841400000000099',
        username: 'will.seed',
        name: 'Will Seed',
        biography: 'Product studio',
        profile_picture_url: 'https://cdn.example/avatar.jpg',
        is_verified: false,
        follower_count: 42,
        unrelated_private_field: 'must not escape the adapter',
      }),
    );
    const adapter = new MetaThreadsProfileAdapter({ fetcher });

    const result = await adapter.lookup({ username: '@Will.Seed', accessToken: 'secret-token' });

    expect(result).toEqual({
      status: 'found',
      profile: {
        platformId: '17841400000000099',
        username: 'will.seed',
        displayName: 'Will Seed',
        biography: 'Product studio',
        profilePictureUrl: 'https://cdn.example/avatar.jpg',
        isVerified: false,
        followerCount: 42,
      },
    });
    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.origin).toBe('https://graph.threads.net');
    expect(requestedUrl.pathname).toBe('/v1.0/profile_lookup');
    expect(requestedUrl.searchParams.get('username')).toBe('will.seed');
  });

  it.each([
    [404, { error: { code: 100 } }, { status: 'not_found' }],
    [403, { error: { code: 10 } }, { status: 'unavailable', reason: 'permission_denied' }],
    [429, { error: { code: 613 } }, { status: 'unavailable', reason: 'rate_limited' }],
    [503, { error: { code: 2 } }, { status: 'unavailable', reason: 'temporary_unavailable' }],
  ])('classifies an HTTP %s response without leaking provider details', async (status, body, expected) => {
    const adapter = new MetaThreadsProfileAdapter({
      fetcher: vi.fn().mockResolvedValue(jsonResponse(body, status)),
    });

    await expect(adapter.lookup({ username: 'target', accessToken: 'secret' })).resolves.toEqual(
      expected,
    );
  });

  it('rejects a successful response for a different target', async () => {
    const adapter = new MetaThreadsProfileAdapter({
      fetcher: vi.fn().mockResolvedValue(jsonResponse({ username: 'another_user' })),
    });

    await expect(adapter.lookup({ username: 'target', accessToken: 'secret' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'malformed_response',
    });
  });

  it('classifies network failures without throwing token-bearing URLs', async () => {
    const adapter = new MetaThreadsProfileAdapter({
      fetcher: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });

    await expect(
      adapter.lookup({ username: 'target', accessToken: 'super-secret' }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'temporary_unavailable' });
  });
});

describe('FailClosedThreadsProfileAdapter', () => {
  it('never falls back to scraping when the official capability is unavailable', async () => {
    const adapter = new FailClosedThreadsProfileAdapter();

    await expect(adapter.lookup({ username: 'target', accessToken: '' })).resolves.toEqual({
      status: 'unavailable',
      reason: 'capability_unavailable',
    });
  });
});
