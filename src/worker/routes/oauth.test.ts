import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { ThreadsOAuthClient } from '../../adapters/threads-oauth/types';
import { createApp } from '../index';
import type { IdentityVerifier } from '../identity/types';
import { connectionCoordinator } from '../coordinator';
import {
  processMetaLifecycleRequest,
  registerMetaLifecycleRequest,
} from '../meta-lifecycle/processor';

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

async function registerLifecycleMarker(issuedAt: number) {
  return registerMetaLifecycleRequest(
    env,
    'deauthorize',
    { userId: CREDENTIAL.identity.platformUserId, issuedAt },
    { idFactory: () => `oauth-race-${issuedAt}` },
  );
}

async function oauthAttemptBoundary(state: string): Promise<number> {
  const stateHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(state),
  );
  const hex = [...new Uint8Array(stateHash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const attempt = await env.DB
    .prepare('SELECT created_at FROM oauth_attempts WHERE state_hash = ?')
    .bind(hex)
    .first<{ created_at: string }>();
  if (!attempt) throw new Error('Missing OAuth test attempt');
  return Math.floor(Date.parse(attempt.created_at) / 1000);
}

async function credentialStatus(connectionId: string) {
  const connection = await env.DB
    .prepare('SELECT tenant_id FROM threads_connections WHERE id = ?')
    .bind(connectionId)
    .first<{ tenant_id: string }>();
  if (!connection) throw new Error('Missing OAuth test connection');
  const coordinator = await connectionCoordinator(
    env,
    connection.tenant_id,
    connectionId,
  );
  return coordinator.stub.credentialStatus(coordinator.ownerDigest);
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

  it('atomically rejects a lifecycle marker that arrives while token exchange is in flight and clears the credential', async () => {
    let signalExchangeEntered: (() => void) | undefined;
    const exchangeEntered = new Promise<void>((resolve) => {
      signalExchangeEntered = resolve;
    });
    let resolveExchange: ((credential: typeof CREDENTIAL) => void) | undefined;
    const exchangeResponse = new Promise<typeof CREDENTIAL>((resolve) => {
      resolveExchange = resolve;
    });
    const exchange = vi.fn(async () => {
      signalExchangeEntered?.();
      return exchangeResponse;
    });
    const { app } = oauthApplication('f'.repeat(64), exchange);
    const connection = await createConnection(app);
    const state = await startOAuth(app, connection.id);

    const callbackPromise = app.request(
      `/auth/threads/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    await exchangeEntered;
    await registerLifecycleMarker(Math.floor(Date.now() / 1000));
    resolveExchange?.(CREDENTIAL);
    const callback = await callbackPromise;
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(
      'https://guard.example/connections?oauth=failed',
    );
    expect(exchange).toHaveBeenCalledTimes(1);

    await expect(
      env.DB
        .prepare(
          `SELECT protected_username, platform_user_id, oauth_granted_at
           FROM threads_connections WHERE id = ?`,
        )
        .bind(connection.id)
        .first(),
    ).resolves.toEqual({
      protected_username: 'unconfirmed.owner',
      platform_user_id: null,
      oauth_granted_at: null,
    });
    await expect(credentialStatus(connection.id)).resolves.toEqual({ connected: false });
  });

  it('rejects a delayed callback for an OAuth attempt created before a completed lifecycle marker', async () => {
    const { app, exchange } = oauthApplication('h'.repeat(64));
    const connection = await createConnection(app);
    const state = await startOAuth(app, connection.id);
    const attemptBoundary = await oauthAttemptBoundary(state);
    const marker = await registerLifecycleMarker(attemptBoundary);
    await expect(
      processMetaLifecycleRequest(env, marker.requestDigest),
    ).resolves.toBe('completed');

    const callback = await app.request(
      `/auth/threads/callback?code=delayed-provider-code&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(
      'https://guard.example/connections?oauth=failed',
    );
    expect(exchange).toHaveBeenCalledTimes(1);
    await expect(
      env.DB
        .prepare(
          `SELECT platform_user_id, oauth_granted_at
           FROM threads_connections WHERE id = ?`,
        )
        .bind(connection.id)
        .first(),
    ).resolves.toEqual({ platform_user_id: null, oauth_granted_at: null });
    await expect(credentialStatus(connection.id)).resolves.toEqual({ connected: false });
  });

  it('allows a genuinely new OAuth grant after an older lifecycle marker', async () => {
    const { app } = oauthApplication('g'.repeat(64));
    const connection = await createConnection(app);
    const olderIssuedAt = Math.floor(Date.now() / 1000) - 60;
    const marker = await registerLifecycleMarker(olderIssuedAt);
    await expect(
      processMetaLifecycleRequest(env, marker.requestDigest),
    ).resolves.toBe('completed');
    const state = await startOAuth(app, connection.id);
    const attemptBoundary = await oauthAttemptBoundary(state);
    expect(attemptBoundary).toBeGreaterThan(olderIssuedAt);

    const callback = await app.request(
      `/auth/threads/callback?code=new-provider-code&state=${encodeURIComponent(state)}`,
      undefined,
      env,
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(
      'https://guard.example/connections?oauth=pending_confirmation',
    );
    const staged = await env.DB
      .prepare(
        `SELECT platform_user_id, oauth_granted_at
         FROM threads_connections WHERE id = ?`,
      )
      .bind(connection.id)
      .first<{ platform_user_id: string; oauth_granted_at: number }>();
    expect(staged?.platform_user_id).toBe(CREDENTIAL.identity.platformUserId);
    expect(staged?.oauth_granted_at).toBe(attemptBoundary);
    await expect(credentialStatus(connection.id)).resolves.toMatchObject({
      connected: true,
      username: CREDENTIAL.identity.username,
    });
  });
});
