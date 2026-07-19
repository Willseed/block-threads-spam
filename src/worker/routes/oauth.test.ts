import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { ThreadsOAuthClient } from '../../adapters/threads-oauth/types';
import { createApp } from '../index';
import type { IdentityVerifier } from '../identity/types';

const CREDENTIAL = {
  accessToken: 'long-lived-token-from-meta',
  tokenType: 'bearer' as const,
  issuedAt: '2026-07-19T07:00:00.000Z',
  expiresAt: '2026-09-17T07:00:00.000Z',
  scopes: ['threads_basic', 'threads_profile_discovery'] as const,
  identity: {
    platformUserId: '17841400000000001',
    username: 'verified.owner',
    displayName: 'Verified Owner',
  },
};

function oauthApplication(sessionBinding: string, exchange = vi.fn().mockResolvedValue(CREDENTIAL)) {
  const verifier: IdentityVerifier = {
    verify: () =>
      Promise.resolve({
        subject: 'idp|oauth-owner',
        authenticatedAt: new Date().toISOString(),
        sessionBinding,
      }),
  };
  const client: ThreadsOAuthClient = { exchangeAuthorizationCode: exchange };
  return {
    app: createApp({ identityVerifier: verifier, oauthClientFactory: () => client }),
    exchange,
  };
}

async function createConnection(app: ReturnType<typeof createApp>) {
  const response = await app.request(
    '/api/connections',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protectedUsername: 'unconfirmed.owner' }),
    },
    env,
  );
  expect(response.status).toBe(201);
  return (await response.json<{ connection: { id: string } }>()).connection;
}

async function startOAuth(app: ReturnType<typeof createApp>, connectionId: string) {
  const response = await app.request(
    `/api/connections/${connectionId}/oauth/start`,
    { method: 'POST' },
    env,
  );
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const body = await response.json<{ authorizationUrl: string }>();
  return new URL(body.authorizationUrl).searchParams.get('state') ?? '';
}

describe('Threads OAuth routes', () => {
  it('consumes state once, stores the credential and stages verified identity', async () => {
    const { app, exchange } = oauthApplication('a'.repeat(64));
    const connection = await createConnection(app);
    const state = await startOAuth(app, connection.id);

    const callback = await app.request(
      `/auth/threads/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(
      'https://guard.example/connections?oauth=pending_confirmation',
    );
    expect(exchange).toHaveBeenCalledWith(
      'provider-code',
      'https://guard.example/auth/threads/callback',
    );

    const list = await app.request('/api/connections', undefined, env);
    await expect(list.json()).resolves.toMatchObject({
      connections: [
        {
          id: connection.id,
          protectedUsername: 'verified.owner',
          platformUserId: '17841400000000001',
          status: 'awaiting_identity_confirmation',
        },
      ],
    });

    const replay = await app.request(
      `/auth/threads/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    expect(replay.status).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('rejects a callback from another application session without consuming the valid attempt', async () => {
    const original = oauthApplication('b'.repeat(64));
    const anotherSession = oauthApplication('c'.repeat(64), original.exchange);
    const connection = await createConnection(original.app);
    const state = await startOAuth(original.app, connection.id);

    const rejected = await anotherSession.app.request(
      `/auth/threads/callback?code=stolen-code&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    expect(rejected.status).toBe(400);
    expect(original.exchange).not.toHaveBeenCalled();

    const accepted = await original.app.request(
      `/auth/threads/callback?code=real-code&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    expect(accepted.status).toBe(303);
    expect(original.exchange).toHaveBeenCalledTimes(1);
  });

  it('requires an exact second confirmation before marking the account connected', async () => {
    const { app } = oauthApplication('d'.repeat(64));
    const connection = await createConnection(app);
    const state = await startOAuth(app, connection.id);
    await app.request(
      `/auth/threads/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );

    const mismatch = await app.request(
      `/api/connections/${connection.id}/oauth/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'another.account' }),
      },
      env,
    );
    expect(mismatch.status).toBe(409);

    const confirmed = await app.request(
      `/api/connections/${connection.id}/oauth/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: '@Verified.Owner' }),
      },
      env,
    );
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({
      connection: { status: 'connected', protectedUsername: 'verified.owner' },
    });
  });

  it('consumes a provider cancellation without exposing state in the clean redirect', async () => {
    const { app, exchange } = oauthApplication('e'.repeat(64));
    const connection = await createConnection(app);
    const state = await startOAuth(app, connection.id);

    const response = await app.request(
      `/auth/threads/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://guard.example/connections?oauth=cancelled',
    );
    expect(response.headers.get('location')).not.toContain(state);
    expect(exchange).not.toHaveBeenCalled();
  });
});
