const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const HMAC_SHA256_BYTES = 32;
const MAX_META_IDENTIFIER_LENGTH = 32;

const encoder = new TextEncoder();

export interface MetaSignedRequest {
  userId: string;
  issuedAt: number;
}

export interface MetaSignedRequestVerificationOptions {
  appId: string | undefined;
  appSecret: string | undefined;
  maxBodyBytes?: number;
  maxFutureSkewSeconds?: number;
  now?: () => Date;
}

export class InvalidMetaSignedRequestError extends Error {
  constructor() {
    super('Invalid Meta signed request');
    this.name = 'InvalidMetaSignedRequestError';
  }
}

export class MetaSignedRequestConfigurationError extends Error {
  constructor() {
    super('Meta signed request verification is not configured');
    this.name = 'MetaSignedRequestConfigurationError';
  }
}

function invalidRequest(): never {
  throw new InvalidMetaSignedRequestError();
}

function positiveSafeInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new MetaSignedRequestConfigurationError();
  }
  return selected;
}

function nonnegativeSafeInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new MetaSignedRequestConfigurationError();
  }
  return selected;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) invalidRequest();

  let binary: string;
  try {
    const padded = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    binary = atob(padded);
  } catch {
    return invalidRequest();
  }

  const decoded = Uint8Array.from(
    binary,
    (character) => character.codePointAt(0) ?? 0,
  );
  if (encodeBase64Url(decoded) !== value) invalidRequest();
  return decoded;
}

async function readLimitedBody(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) invalidRequest();
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) invalidRequest();
  }

  if (!request.body) invalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    let result = await reader.read();
    while (!result.done) {
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        invalidRequest();
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } catch (error) {
    if (error instanceof InvalidMetaSignedRequestError) throw error;
    return invalidRequest();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalidRequest();
  }
}

function formSignedRequest(body: string): string {
  const parameters = new URLSearchParams(body);
  const entries = [...parameters.entries()];
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== 'signed_request' ||
    !entries[0][1]
  ) {
    invalidRequest();
  }
  return entries[0][1];
}

function normalizedPayloadAppId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return invalidRequest();
}

function parsePayload(
  payloadBytes: Uint8Array,
  configuredAppId: string,
  now: Date,
  maximumFutureSkewSeconds: number,
): MetaSignedRequest {
  let decoded: string;
  let payload: unknown;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    payload = JSON.parse(decoded) as unknown;
  } catch {
    return invalidRequest();
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalidRequest();
  const fields = payload as Record<string, unknown>;

  if (fields.algorithm !== 'HMAC-SHA256') invalidRequest();
  if (
    typeof fields.user_id !== 'string' ||
    !new RegExp(`^[1-9][0-9]{0,${MAX_META_IDENTIFIER_LENGTH - 1}}$`, 'u').test(
      fields.user_id,
    )
  ) {
    invalidRequest();
  }
  if (
    typeof fields.issued_at !== 'number' ||
    !Number.isSafeInteger(fields.issued_at) ||
    fields.issued_at <= 0
  ) {
    invalidRequest();
  }

  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new MetaSignedRequestConfigurationError();
  }
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  if (fields.issued_at > nowSeconds + maximumFutureSkewSeconds) invalidRequest();

  const payloadAppId = normalizedPayloadAppId(fields.app_id);
  if (payloadAppId !== undefined && payloadAppId !== configuredAppId) invalidRequest();

  return { userId: fields.user_id, issuedAt: fields.issued_at };
}

/**
 * Verifies a Meta form POST containing one signed_request value.
 *
 * Meta does not include app_id in every callback payload. When present, app_id is
 * required to match the configured app; the HMAC secret scopes payloads that omit it.
 */
export async function verifyMetaSignedRequest(
  request: Request,
  options: MetaSignedRequestVerificationOptions,
): Promise<MetaSignedRequest> {
  if (!options.appId || !options.appSecret) {
    throw new MetaSignedRequestConfigurationError();
  }
  const maximumBytes = positiveSafeInteger(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
  );
  const maximumFutureSkewSeconds = nonnegativeSafeInteger(
    options.maxFutureSkewSeconds,
    DEFAULT_MAX_FUTURE_SKEW_SECONDS,
  );

  if (request.method !== 'POST') invalidRequest();
  const contentType = request.headers.get('content-type');
  if (contentType?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US') !== 'application/x-www-form-urlencoded') {
    invalidRequest();
  }

  const body = await readLimitedBody(request, maximumBytes);
  const signedRequest = formSignedRequest(body);
  const segments = signedRequest.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) invalidRequest();

  const signature = decodeBase64Url(segments[0]);
  if (signature.byteLength !== HMAC_SHA256_BYTES) invalidRequest();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(options.appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(segments[1]),
  );
  if (!verified) invalidRequest();

  const payloadBytes = decodeBase64Url(segments[1]);
  return parsePayload(
    payloadBytes,
    options.appId,
    options.now?.() ?? new Date(),
    maximumFutureSkewSeconds,
  );
}
