import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { app, createApp } from './index';
import type { IdentityVerifier } from './identity/types';

describe('health endpoint', () => {
  it('reports that the service is available', async () => {
    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: 'threads-variant-guard',
      status: 'ok',
    });
  });
});

describe('application identity', () => {
  it('rejects protected API requests without a configured identity provider', async () => {
    const response = await app.request('/api/me');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  it('returns only the verified application identity', async () => {
    const verifier: IdentityVerifier = {
      verify: () =>
        Promise.resolve({
          subject: 'identity-provider|immutable-user-id',
          email: 'owner@example.com',
          authenticatedAt: '2026-07-19T06:00:00.000Z',
        }),
    };
    const protectedApp = createApp({ identityVerifier: verifier });

    const response = await protectedApp.request('/api/me', undefined, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      subject: 'identity-provider|immutable-user-id',
      email: 'owner@example.com',
      authenticatedAt: '2026-07-19T06:00:00.000Z',
    });
  });

  it('keeps unknown API paths as JSON 404 responses', async () => {
    const verifier: IdentityVerifier = {
      verify: () => Promise.resolve({ subject: 'user-id' }),
    };
    const protectedApp = createApp({ identityVerifier: verifier });

    const response = await protectedApp.request('/api/unknown', undefined, env);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('reports destructive capabilities as disabled with the production provider', async () => {
    const verifier: IdentityVerifier = {
      verify: () => Promise.resolve({ subject: 'user-id' }),
    };
    const protectedApp = createApp({ identityVerifier: verifier });
    const response = await protectedApp.request('/api/capabilities', undefined, env);

    await expect(response.json()).resolves.toMatchObject({
      capabilities: { manualBlockHandoff: false, automatedBlock: false },
    });
  });
});
