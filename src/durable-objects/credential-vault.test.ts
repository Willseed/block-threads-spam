import { describe, expect, it } from 'vitest';

import { decryptAccessToken, encryptCredential, parseVaultKey } from './credential-vault';

const OWNER = 'a'.repeat(64);
const KEK = 'ERERERERERERERERERERERERERERERERERERERERERE';
const CREDENTIAL = {
  accessToken: 'do-not-persist-this-plaintext',
  tokenType: 'bearer' as const,
  issuedAt: '2026-07-19T00:00:00.000Z',
  expiresAt: '2026-09-17T00:00:00.000Z',
  scopes: ['threads_basic', 'threads_profile_discovery'] as const,
  identity: {
    platformUserId: '123456789',
    username: 'official.account',
  },
};

describe('credential vault encryption', () => {
  it('uses a random DEK and round-trips a token without plaintext at rest', async () => {
    const first = await encryptCredential(OWNER, CREDENTIAL, KEK);
    const second = await encryptCredential(OWNER, CREDENTIAL, KEK);

    expect(JSON.stringify(first)).not.toContain(CREDENTIAL.accessToken);
    expect(first.tokenCiphertext).not.toBe(second.tokenCiphertext);
    await expect(decryptAccessToken(first, KEK)).resolves.toBe(CREDENTIAL.accessToken);
  });

  it('binds ciphertext integrity to the owner and platform identity', async () => {
    const encrypted = await encryptCredential(OWNER, CREDENTIAL, KEK);
    const tampered = {
      ...encrypted,
      identity: { ...encrypted.identity, platformUserId: '987654321' },
    };

    await expect(decryptAccessToken(tampered, KEK)).rejects.toThrow();
  });

  it('fails closed for missing or malformed key material', () => {
    expect(() => parseVaultKey(undefined)).toThrow('Credential vault is not configured');
    expect(() => parseVaultKey('not-a-32-byte-key')).toThrow(
      'Credential vault is not configured',
    );
  });
});
