import type { ThreadsOAuthCredential } from '../adapters/threads-oauth/types';

const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface EncryptedThreadsCredential {
  version: 1;
  ownerDigest: string;
  wrappedDek: string;
  wrapIv: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenType: 'bearer';
  issuedAt: string;
  expiresAt: string;
  scopes: readonly ['threads_basic', 'threads_profile_discovery'];
  identity: ThreadsOAuthCredential['identity'];
}

function encode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError('Invalid base64url value');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}

async function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(label: string, ownerDigest: string, platformUserId?: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    platformUserId ? `${label}\0${ownerDigest}\0${platformUserId}` : `${label}\0${ownerDigest}`,
  );
}

function assertOwnerDigest(ownerDigest: string): void {
  if (!/^[a-f0-9]{64}$/u.test(ownerDigest)) throw new TypeError('Invalid owner digest');
}

export function parseVaultKey(value: string | undefined): Uint8Array<ArrayBuffer> {
  if (!value) throw new Error('Credential vault is not configured');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decode(value);
  } catch {
    throw new Error('Credential vault is not configured');
  }
  if (bytes.byteLength !== KEY_BYTES) throw new Error('Credential vault is not configured');
  return bytes;
}

export async function encryptCredential(
  ownerDigest: string,
  credential: ThreadsOAuthCredential,
  encodedKek: string | undefined,
): Promise<EncryptedThreadsCredential> {
  assertOwnerDigest(ownerDigest);
  const kek = await importAesKey(parseVaultKey(encodedKek));
  const dekBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const dek = await importAesKey(dekBytes);
  const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const tokenIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const [wrappedDek, tokenCiphertext] = await Promise.all([
    crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: wrapIv, additionalData: aad('threads-dek-v1', ownerDigest) },
      kek,
      dekBytes,
    ),
    crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: tokenIv,
        additionalData: aad('threads-token-v1', ownerDigest, credential.identity.platformUserId),
      },
      dek,
      new TextEncoder().encode(credential.accessToken),
    ),
  ]);

  return {
    version: 1,
    ownerDigest,
    wrappedDek: encode(wrappedDek),
    wrapIv: encode(wrapIv),
    tokenCiphertext: encode(tokenCiphertext),
    tokenIv: encode(tokenIv),
    tokenType: credential.tokenType,
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
    scopes: credential.scopes,
    identity: credential.identity,
  };
}

export async function decryptAccessToken(
  encrypted: EncryptedThreadsCredential,
  encodedKek: string | undefined,
): Promise<string> {
  assertOwnerDigest(encrypted.ownerDigest);
  const kek = await importAesKey(parseVaultKey(encodedKek));
  const dekBytes = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decode(encrypted.wrapIv),
      additionalData: aad('threads-dek-v1', encrypted.ownerDigest),
    },
    kek,
    decode(encrypted.wrappedDek),
  );
  const dek = await importAesKey(new Uint8Array(dekBytes));
  const token = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decode(encrypted.tokenIv),
      additionalData: aad(
        'threads-token-v1',
        encrypted.ownerDigest,
        encrypted.identity.platformUserId,
      ),
    },
    dek,
    decode(encrypted.tokenCiphertext),
  );
  return new TextDecoder().decode(token);
}
