import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CloudflareAccessVerifier } from './cloudflare-access';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function accessTokenFixture(audience = 'expected-audience') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const issuer = `https://team-${crypto.randomUUID()}.cloudflareaccess.com`;
  const token = await new SignJWT({ email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .setSubject('immutable-user-id')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(1_784_443_600)
    .setExpirationTime('5m')
    .sign(privateKey);

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, alg: 'RS256', kid: 'fixture-key', use: 'sig' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    ),
  );

  return { issuer, token };
}

describe('CloudflareAccessVerifier', () => {
  it('verifies the signature, issuer, audience and immutable subject', async () => {
    const { issuer, token } = await accessTokenFixture();
    const verifier = new CloudflareAccessVerifier({
      POLICY_AUD: 'expected-audience',
      TEAM_DOMAIN: issuer,
    });

    const identity = await verifier.verify(
      new Request('https://app.example/api/me', {
        headers: { 'cf-access-jwt-assertion': token },
      }),
    );

    expect(identity).toMatchObject({
      subject: 'immutable-user-id',
      email: 'owner@example.com',
      authenticatedAt: '2026-07-19T06:46:40.000Z',
    });
    expect(identity.sessionBinding).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a correctly signed token for another Access application', async () => {
    const { issuer, token } = await accessTokenFixture('another-audience');
    const verifier = new CloudflareAccessVerifier({
      POLICY_AUD: 'expected-audience',
      TEAM_DOMAIN: issuer,
    });

    await expect(
      verifier.verify(
        new Request('https://app.example/api/me', {
          headers: { 'cf-access-jwt-assertion': token },
        }),
      ),
    ).rejects.toThrow('Authentication failed');
  });

  it('fails closed when configuration is missing', () => {
    expect(() => new CloudflareAccessVerifier({})).toThrow('Identity provider is not configured');
  });
});
