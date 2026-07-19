import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import {
  buildMetaThreadsAuthorizationUrl,
  MetaThreadsOAuthClient,
} from '../../adapters/threads-oauth/meta-oauth';
import type { ThreadsOAuthClient } from '../../adapters/threads-oauth/types';
import { parseUsername } from '../../domain/usernames';
import type { AppBindings, AppEnvironment } from '../environment';
import { connectionCoordinator } from '../coordinator';
import { requireRecentAuthentication } from '../identity/reauthentication';
import { deriveMetaPlatformSubjectDigest } from '../meta-lifecycle/processor';

const OAUTH_TTL_MILLISECONDS = 10 * 60 * 1000;
const STATE_BYTES = 32;

const confirmationInput = z.object({ username: z.string().min(1).max(31) });

export type OAuthClientFactory = (bindings: AppBindings) => ThreadsOAuthClient;

function oauthClient(bindings: AppBindings, factory?: OAuthClientFactory): ThreadsOAuthClient {
  return factory?.(bindings) ?? new MetaThreadsOAuthClient({
    appId: bindings.META_APP_ID ?? '',
    appSecret: bindings.META_APP_SECRET ?? '',
    apiVersion: bindings.META_GRAPH_API_VERSION,
  });
}

function applicationOrigin(value: string | undefined): URL {
  if (!value) throw new Error('Application origin is not configured');
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Application origin is not configured');
  }
  return origin;
}

function callbackUri(bindings: AppBindings): string {
  return new URL('/auth/threads/callback', applicationOrigin(bindings.APP_ORIGIN)).toString();
}

function cleanRedirect(bindings: AppBindings, result: string): string {
  const target = new URL('/connections', applicationOrigin(bindings.APP_ORIGIN));
  target.searchParams.set('oauth', result);
  return target.toString();
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(STATE_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function invalidState(context: Context<AppEnvironment>) {
  return context.json(
    { error: { code: 'invalid_oauth_state', message: '連線要求已失效，請重新開始。' } },
    400,
    { 'cache-control': 'no-store' },
  );
}

export function oauthConnectionRoutes(factory?: OAuthClientFactory) {
  const routes = new Hono<AppEnvironment>();

  routes.post('/:connectionId/oauth/start', requireRecentAuthentication, async (context) => {
    const identity = context.get('identity');
    if (!identity.sessionBinding) {
      return context.json(
        { error: { code: 'reauthentication_required', message: '請重新登入本服務後再試。' } },
        403,
      );
    }

    const tenant = context.get('tenant');
    const repository = context.get('repository');
    const connection = await repository.getConnection(tenant, context.req.param('connectionId'));
    if (
      connection?.connectionMode !== 'meta_oauth' ||
      connection.status === 'revoked' ||
      connection.status === 'revoking'
    ) {
      return context.json(
        { error: { code: 'not_found', message: '找不到指定的 Threads 連線。' } },
        404,
      );
    }

    let redirectUri: string;
    let authorizationUrl: string;
    let coordinator: Awaited<ReturnType<typeof connectionCoordinator>>;
    const state = randomState();
    const jobId = `oauth-${crypto.randomUUID()}`;
    try {
      redirectUri = callbackUri(context.env);
      authorizationUrl = buildMetaThreadsAuthorizationUrl(
        context.env.META_APP_ID ?? '',
        redirectUri,
        state,
      );
      oauthClient(context.env, factory);
      coordinator = await connectionCoordinator(
        context.env,
        tenant.tenantId,
        connection.id,
      );
    } catch {
      return context.json(
        { error: { code: 'service_unavailable', message: 'Threads 連線目前未設定完成。' } },
        503,
      );
    }

    const lease = await coordinator.stub.acquire({
      ownerDigest: coordinator.ownerDigest,
      revocationVersion: connection.revocationVersion,
      jobId,
      kind: 'connect',
      ttlSeconds: OAUTH_TTL_MILLISECONDS / 1000,
    });
    if (lease.status !== 'acquired') {
      return context.json(
        { error: { code: 'connection_busy', message: '這個帳號已有連線工作進行中。' } },
        409,
      );
    }

    const expiresAt = new Date(Date.now() + OAUTH_TTL_MILLISECONDS).toISOString();
    try {
      await repository.createOAuthAttempt(tenant, {
        stateHash: await sha256(state),
        sessionBinding: identity.sessionBinding,
        connectionId: connection.id,
        redirectUri,
        jobId,
        leaseGeneration: lease.generation,
        expiresAt,
      });
    } catch {
      await coordinator.stub.release(coordinator.ownerDigest, jobId, lease.generation);
      return context.json(
        { error: { code: 'service_unavailable', message: '目前無法開始 Threads 連線。' } },
        503,
      );
    }

    return context.json(
      { authorizationUrl, expiresAt },
      201,
      { 'cache-control': 'private, no-store' },
    );
  });

  routes.post('/:connectionId/oauth/confirm', requireRecentAuthentication, async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    const parsed = confirmationInput.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: { code: 'invalid_request', message: '請確認要保護的完整帳號名稱。' } },
        400,
      );
    }
    let username: string;
    try {
      username = parseUsername(parsed.data.username);
    } catch {
      return context.json(
        { error: { code: 'invalid_request', message: '請確認要保護的完整帳號名稱。' } },
        400,
      );
    }
    let credentialStatus;
    try {
      const coordinator = await connectionCoordinator(
        context.env,
        context.get('tenant').tenantId,
        context.req.param('connectionId'),
      );
      credentialStatus = await coordinator.stub.credentialStatus(coordinator.ownerDigest);
    } catch {
      return context.json(
        { error: { code: 'service_unavailable', message: '目前無法確認 Threads 連線。' } },
        503,
      );
    }
    if (!credentialStatus?.connected || credentialStatus.username !== username) {
      return context.json(
        { error: { code: 'identity_mismatch', message: '確認的帳號與 Threads 授權身分不一致。' } },
        409,
      );
    }
    const connection = await context.get('repository').confirmOAuthIdentity(
      context.get('tenant'),
      context.req.param('connectionId'),
      username,
    );
    if (!connection) {
      return context.json(
        { error: { code: 'identity_mismatch', message: '確認的帳號與 Threads 授權身分不一致。' } },
        409,
      );
    }
    return context.json({ connection });
  });

  return routes;
}

export function oauthCallbackRoutes(factory?: OAuthClientFactory) {
  const routes = new Hono<AppEnvironment>();

  routes.get('/callback', async (context) => {
    const url = new URL(context.req.url);
    const states = url.searchParams.getAll('state');
    const codes = url.searchParams.getAll('code');
    const errors = url.searchParams.getAll('error');
    if (
      states.length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/u.test(states[0] ?? '') ||
      codes.length > 1 ||
      errors.length > 1
    ) {
      return invalidState(context);
    }

    const identity = context.get('identity');
    if (!identity.sessionBinding) return invalidState(context);
    const tenant = context.get('tenant');
    const attempt = await context.get('repository').consumeOAuthAttempt(
      tenant,
      await sha256(states[0]),
      identity.sessionBinding,
    );
    if (!attempt) return invalidState(context);

    const coordinator = await connectionCoordinator(
      context.env,
      tenant.tenantId,
      attempt.connectionId,
    );
    try {
      if (errors.length === 1 || codes.length !== 1 || !codes[0]) {
        return context.redirect(cleanRedirect(context.env, 'cancelled'), 303);
      }

      const credential = await oauthClient(context.env, factory).exchangeAuthorizationCode(
        codes[0],
        attempt.redirectUri,
      );
      const platformSubjectDigest = await deriveMetaPlatformSubjectDigest(
        context.env,
        credential.identity.platformUserId,
      );
      const stored = await coordinator.stub.storeCredential(coordinator.ownerDigest, credential);
      if (!stored) throw new Error('Credential ownership rejected');
      try {
        await context.get('repository').stageOAuthIdentity(
          tenant,
          attempt.connectionId,
          credential.identity.platformUserId,
          credential.identity.username,
          platformSubjectDigest,
          attempt.authorizationBoundarySeconds,
        );
      } catch (error) {
        await coordinator.stub.clearCredential(coordinator.ownerDigest);
        throw error;
      }
      return context.redirect(cleanRedirect(context.env, 'pending_confirmation'), 303);
    } catch {
      return context.redirect(cleanRedirect(context.env, 'failed'), 303);
    } finally {
      await coordinator.stub.release(
        coordinator.ownerDigest,
        attempt.jobId,
        attempt.leaseGeneration,
      );
    }
  });

  return routes;
}
