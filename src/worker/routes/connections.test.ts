import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createApp } from '../index';
import type { IdentityVerifier } from '../identity/types';

function applicationFor(subject: string) {
  const verifier: IdentityVerifier = {
    verify: () => Promise.resolve({ subject }),
  };
  return createApp({ identityVerifier: verifier });
}

async function createConnection(subject = 'idp|owner') {
  const response = await applicationFor(subject).request(
    '/api/connections',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protectedUsername: '@WillSeed' }),
    },
    env,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ connection: { id: string; protectedUsername: string } }>();
  return body.connection;
}

describe('connection and manual candidate API', () => {
  it('creates a normalized connection inside the authenticated personal tenant', async () => {
    const connection = await createConnection();

    expect(connection.protectedUsername).toBe('willseed');
    const response = await applicationFor('idp|owner').request(
      '/api/connections',
      undefined,
      env,
    );
    const body = await response.json<{ connections: { id: string }[] }>();
    expect(body.connections.map(({ id }) => id)).toContain(connection.id);
  });

  it('adds and lists one explicit candidate with an explanation', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');
    const createResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: '@Will.Seed' }),
      },
      env,
    );

    expect(createResponse.status).toBe(201);
    const listResponse = await app.request(
      `/api/connections/${connection.id}/candidates`,
      undefined,
      env,
    );
    const body = await listResponse.json<{
      candidates: { username: string; reasons: string[] }[];
    }>();
    expect(body.candidates).toEqual([
      expect.objectContaining({
        username: 'will.seed',
        reasons: ['使用者人工加入完整帳號名稱'],
      }),
    ]);
  });

  it('does not expose or mutate a guessed connection from another tenant', async () => {
    const connection = await createConnection('idp|owner');
    const attacker = applicationFor('idp|attacker');

    const createResponse = await attacker.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'lookalike' }),
      },
      env,
    );
    expect(createResponse.status).toBe(404);

    const listResponse = await attacker.request(
      `/api/connections/${connection.id}/candidates`,
      undefined,
      env,
    );
    await expect(listResponse.json()).resolves.toEqual({ candidates: [] });
  });

  it('rejects malformed or duplicate candidate input', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');

    const invalid = await app.request(
      `/api/connections/${connection.id}/candidates`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'bad name' }),
      },
      env,
    );
    expect(invalid.status).toBe(400);

    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lookalike' }),
    };
    expect(
      (await app.request(`/api/connections/${connection.id}/candidates`, request, env)).status,
    ).toBe(201);
    expect(
      (await app.request(`/api/connections/${connection.id}/candidates`, request, env)).status,
    ).toBe(409);
  });

  it('generates a bounded server-side candidate snapshot idempotently', async () => {
    const connection = await createConnection();
    const app = applicationFor('idp|owner');
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabledRules: ['punctuation'],
        totalLimit: 5,
        perRuleLimit: 5,
      }),
    };

    const first = await app.request(
      `/api/connections/${connection.id}/candidates/generate`,
      request,
      env,
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      snapshot: { generated: 5, created: 5, limits: { total: 5, perRule: 5 } },
    });

    const second = await app.request(
      `/api/connections/${connection.id}/candidates/generate`,
      request,
      env,
    );
    await expect(second.json()).resolves.toMatchObject({
      snapshot: { generated: 5, created: 0 },
    });
  });

  it('refuses to generate against another tenant connection', async () => {
    const connection = await createConnection('idp|owner');
    const response = await applicationFor('idp|attacker').request(
      `/api/connections/${connection.id}/candidates/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      env,
    );

    expect(response.status).toBe(404);
  });
});
