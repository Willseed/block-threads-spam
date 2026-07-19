import { describe, expect, it } from 'vitest';

import {
  InvalidMetaSignedRequestError,
  MetaSignedRequestConfigurationError,
  verifyMetaSignedRequest,
} from './signed-request';

const APP_ID = '123456789012345';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const NOW = new Date('2026-07-20T06:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const encoder = new TextEncoder();

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function signEncodedPayload(payload: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${encodeBase64Url(new Uint8Array(signature))}.${payload}`;
}

async function signedRequest(
  payload: Record<string, unknown>,
  secret = APP_SECRET,
): Promise<string> {
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  return signEncodedPayload(encodedPayload, secret);
}

function callbackRequest(
  value: string,
  options: { body?: string; contentType?: string; method?: string } = {},
): Request {
  return new Request('https://guard.example/meta/threads/data-deletion', {
    method: options.method ?? 'POST',
    headers: {
      'content-type': options.contentType ?? 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body:
      options.method === 'GET'
        ? undefined
        : (options.body ?? new URLSearchParams({ signed_request: value }).toString()),
  });
}

function verificationOptions(overrides: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    appSecret: APP_SECRET,
    now: () => NOW,
    ...overrides,
  };
}

const validPayload = () => ({
  algorithm: 'HMAC-SHA256',
  user_id: '17841400000000001',
  issued_at: NOW_SECONDS,
  app_id: APP_ID,
});

describe('Meta signed request verification', () => {
  it('verifies a canonical signed form request and returns only lifecycle identity fields', async () => {
    const value = await signedRequest(validPayload());

    await expect(
      verifyMetaSignedRequest(callbackRequest(value), verificationOptions()),
    ).resolves.toEqual({
      userId: '17841400000000001',
      issuedAt: NOW_SECONDS,
    });
  });

  it('accepts the standard payload when app_id is omitted because the app secret scopes it', async () => {
    const payload = validPayload();
    delete (payload as Partial<typeof payload>).app_id;
    const value = await signedRequest(payload);

    await expect(
      verifyMetaSignedRequest(callbackRequest(value), verificationOptions()),
    ).resolves.toMatchObject({ userId: '17841400000000001' });
  });

  it('accepts a matching safe numeric app_id', async () => {
    const value = await signedRequest({ ...validPayload(), app_id: Number(APP_ID) });

    await expect(
      verifyMetaSignedRequest(callbackRequest(value), verificationOptions()),
    ).resolves.toMatchObject({ userId: '17841400000000001' });
  });

  it.each([
    ['a mismatched secret', async () => signedRequest(validPayload(), 'another-app-secret')],
    [
      'a tampered payload',
      async () => {
        const value = await signedRequest(validPayload());
        const [signature, payload] = value.split('.');
        return `${signature}.${payload.slice(0, -1)}A`;
      },
    ],
    [
      'a mismatched app_id',
      async () => signedRequest({ ...validPayload(), app_id: '999999999999999' }),
    ],
    [
      'an unsupported algorithm',
      async () => signedRequest({ ...validPayload(), algorithm: 'HMAC-SHA1' }),
    ],
    [
      'a numeric user_id',
      async () => signedRequest({ ...validPayload(), user_id: 123456789 }),
    ],
    [
      'a non-decimal user_id',
      async () => signedRequest({ ...validPayload(), user_id: 'user-123' }),
    ],
    [
      'a string issued_at',
      async () => signedRequest({ ...validPayload(), issued_at: String(NOW_SECONDS) }),
    ],
    [
      'a request beyond the future clock allowance',
      async () => signedRequest({ ...validPayload(), issued_at: NOW_SECONDS + 301 }),
    ],
  ])('rejects %s', async (_label, buildValue) => {
    const value = await buildValue();

    await expect(
      verifyMetaSignedRequest(callbackRequest(value), verificationOptions()),
    ).rejects.toBeInstanceOf(InvalidMetaSignedRequestError);
  });

  it('accepts an issued_at value exactly at the configured future-skew boundary', async () => {
    const value = await signedRequest({ ...validPayload(), issued_at: NOW_SECONDS + 300 });

    await expect(
      verifyMetaSignedRequest(callbackRequest(value), verificationOptions()),
    ).resolves.toMatchObject({ issuedAt: NOW_SECONDS + 300 });
  });

  it('rejects duplicate or additional form fields', async () => {
    const value = await signedRequest(validPayload());
    const duplicate = `signed_request=${encodeURIComponent(value)}&signed_request=${encodeURIComponent(value)}`;
    const additional = `signed_request=${encodeURIComponent(value)}&unexpected=1`;

    await expect(
      verifyMetaSignedRequest(
        callbackRequest(value, { body: duplicate }),
        verificationOptions(),
      ),
    ).rejects.toBeInstanceOf(InvalidMetaSignedRequestError);
    await expect(
      verifyMetaSignedRequest(
        callbackRequest(value, { body: additional }),
        verificationOptions(),
      ),
    ).rejects.toBeInstanceOf(InvalidMetaSignedRequestError);
  });

  it('rejects a body over the configured byte limit', async () => {
    const value = await signedRequest(validPayload());
    const body = new URLSearchParams({ signed_request: value }).toString();

    await expect(
      verifyMetaSignedRequest(
        callbackRequest(value, { body }),
        verificationOptions({ maxBodyBytes: body.length - 1 }),
      ),
    ).rejects.toBeInstanceOf(InvalidMetaSignedRequestError);
  });

  it('rejects non-POST and non-form requests', async () => {
    const value = await signedRequest(validPayload());

    await expect(
      verifyMetaSignedRequest(
        callbackRequest(value, { method: 'GET' }),
        verificationOptions(),
      ),
    ).rejects.toBeInstanceOf(InvalidMetaSignedRequestError);
    await expect(
      verifyMetaSignedRequest(
        callbackRequest(value, { contentType: 'application/json' }),
        verificationOptions(),
      ),
    ).rejects.toBeInstanceOf(InvalidMetaSignedRequestError);
  });

  it('rejects padded and non-canonical base64url signatures', async () => {
    const value = await signedRequest(validPayload());
    const [signature, payload] = value.split('.');
    if (!signature || !payload) throw new Error('Invalid test fixture');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const finalIndex = alphabet.indexOf(signature.at(-1) ?? '');
    const nonCanonicalFinalCharacter = alphabet[(finalIndex & 0b111100) + 1];
    if (!nonCanonicalFinalCharacter) throw new Error('Invalid test fixture');
    const nonCanonical = `${signature.slice(0, -1)}${nonCanonicalFinalCharacter}.${payload}`;

    await expect(
      verifyMetaSignedRequest(callbackRequest(`${signature}=.${payload}`), verificationOptions()),
    ).rejects.toBeInstanceOf(InvalidMetaSignedRequestError);
    await expect(
      verifyMetaSignedRequest(callbackRequest(nonCanonical), verificationOptions()),
    ).rejects.toBeInstanceOf(InvalidMetaSignedRequestError);
  });

  it('fails closed when the verifier is not configured', async () => {
    const value = await signedRequest(validPayload());

    await expect(
      verifyMetaSignedRequest(
        callbackRequest(value),
        verificationOptions({ appSecret: undefined }),
      ),
    ).rejects.toBeInstanceOf(MetaSignedRequestConfigurationError);
  });
});
