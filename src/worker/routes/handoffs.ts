import { Hono } from 'hono';
import { z } from 'zod';

import { FailClosedBrowserHandoffProvider } from '../../adapters/browser-handoff/fail-closed';
import type {
  BrowserHandoffProvider,
  HandoffScope,
  PreparedBrowserHandoff,
} from '../../adapters/browser-handoff/types';
import type { AppEnvironment } from '../environment';
import { connectionCoordinator } from '../coordinator';
import { requireRecentAuthentication } from '../identity/reauthentication';

const HANDOFF_TTL_MILLISECONDS = 8 * 60 * 1000;
const inputSchema = z.object({
  approvalId: z.string().min(1).max(128),
  actionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

function providerOrDefault(provider?: BrowserHandoffProvider): BrowserHandoffProvider {
  return provider ?? new FailClosedBrowserHandoffProvider();
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookie = request.headers.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function expectedOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function createHandoffRoutes(injectedProvider?: BrowserHandoffProvider) {
  const routes = new Hono<AppEnvironment>();
  const provider = providerOrDefault(injectedProvider);

  routes.post('/', requireRecentAuthentication, async (context) => {
    if (
      context.env.FEATURE_MANUAL_BLOCK_HANDOFF !== 'true' ||
      context.env.FEATURE_BROWSER_LIVE_VIEW !== 'true' ||
      !provider.isAvailable()
    ) {
      return context.json(
        { error: { code: 'capability_unavailable', message: '安全人工交接目前無法使用。' } },
        503,
      );
    }
    const identity = context.get('identity');
    if (!identity.sessionBinding) {
      return context.json(
        { error: { code: 'reauthentication_required', message: '請重新登入本服務後再試。' } },
        403,
      );
    }
    const body: unknown = await context.req.json().catch(() => undefined);
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        { error: { code: 'invalid_request', message: '批准內容無效或已失效。' } },
        400,
      );
    }
    const tenant = context.get('tenant');
    const repository = context.get('repository');
    const approval = await repository.consumeApproval(
      tenant,
      parsed.data.approvalId,
      await sha256(parsed.data.actionToken),
      identity.sessionBinding,
    );
    if (!approval) {
      return context.json(
        { error: { code: 'approval_invalid', message: '批准已失效、已使用或不屬於目前工作階段。' } },
        409,
      );
    }
    const connection = await repository.getConnection(tenant, approval.connectionId);
    if (!connection || connection.status !== 'connected') {
      await repository.failHandoffBeforeIssue(tenant, approval.id);
      return context.json(
        { error: { code: 'connection_required', message: 'Threads 連線已失效。' } },
        409,
      );
    }

    const handoffId = `hnd_${crypto.randomUUID()}`;
    const jobId = `job_${crypto.randomUUID()}`;
    const exchangeToken = randomToken();
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MILLISECONDS).toISOString();
    const scope: HandoffScope = {
      handoffId,
      approvedUsername: approval.exactTargetUsername,
      approvedPlatformId: approval.targetPlatformId,
      absoluteDeadlineAt: expiresAt,
    };
    const coordinator = await connectionCoordinator(
      context.env,
      tenant.tenantId,
      approval.connectionId,
    );
    const lease = await coordinator.stub.acquire({
      ownerDigest: coordinator.ownerDigest,
      revocationVersion: connection.revocationVersion,
      jobId,
      kind: 'manual_block',
      ttlSeconds: HANDOFF_TTL_MILLISECONDS / 1000,
    });
    if (lease.status !== 'acquired') {
      await repository.failHandoffBeforeIssue(tenant, approval.id);
      return context.json(
        { error: { code: 'connection_busy', message: '這個帳號已有工作進行中。' } },
        409,
      );
    }

    let prepared: PreparedBrowserHandoff | undefined;
    try {
      prepared = await provider.prepare(scope);
      await repository.createBrowserHandoff(tenant, {
        id: handoffId,
        jobId,
        approval,
        browserSessionId: prepared.browserSessionId,
        targetId: prepared.targetId,
        exchangeTokenHash: await sha256(exchangeToken),
        sessionBinding: identity.sessionBinding,
        expiresAt,
        leaseGeneration: lease.generation,
      });
    } catch {
      if (prepared) await provider.close(prepared.browserSessionId).catch(() => undefined);
      await coordinator.stub.release(coordinator.ownerDigest, jobId, lease.generation);
      await repository.failHandoffBeforeIssue(tenant, approval.id, handoffId);
      return context.json(
        { error: { code: 'capability_unavailable', message: '安全人工交接建立失敗。' } },
        503,
      );
    }

    return context.json(
      {
        handoff: {
          id: handoffId,
          enterPath: `/api/handoffs/${encodeURIComponent(handoffId)}/enter`,
          expiresAt,
          exactTargetUsername: approval.exactTargetUsername,
        },
      },
      201,
      {
        'cache-control': 'private, no-store',
        'set-cookie': `__Host-handoff_exchange=${exchangeToken}; Max-Age=480; Path=/; Secure; HttpOnly; SameSite=Strict`,
      },
    );
  });

  routes.post('/:handoffId/enter', async (context) => {
    const identity = context.get('identity');
    const origin = expectedOrigin(context.env.APP_ORIGIN);
    if (
      !origin ||
      context.req.header('origin') !== origin ||
      !identity.sessionBinding ||
      context.env.FEATURE_MANUAL_BLOCK_HANDOFF !== 'true' ||
      context.env.FEATURE_BROWSER_LIVE_VIEW !== 'true' ||
      !provider.isAvailable()
    ) {
      return context.json(
        { error: { code: 'handoff_invalid', message: '人工交接已失效。' } },
        400,
      );
    }
    const exchangeToken = cookieValue(context.req.raw, '__Host-handoff_exchange');
    if (!exchangeToken) {
      return context.json(
        { error: { code: 'handoff_invalid', message: '人工交接已失效。' } },
        400,
      );
    }
    const tenant = context.get('tenant');
    const repository = context.get('repository');
    const handoff = await repository.claimBrowserHandoff(
      tenant,
      context.req.param('handoffId'),
      await sha256(exchangeToken),
      identity.sessionBinding,
    );
    if (!handoff) {
      return context.json(
        { error: { code: 'handoff_invalid', message: '人工交接已使用或已失效。' } },
        409,
      );
    }
    const scope: HandoffScope = {
      handoffId: handoff.id,
      approvedUsername: handoff.exactTargetUsername,
      approvedPlatformId: handoff.targetPlatformId,
      absoluteDeadlineAt: handoff.expiresAt,
    };
    try {
      const liveViewUrl = new URL(
        await provider.liveViewUrl(
          { browserSessionId: handoff.browserSessionId, targetId: handoff.targetId },
          scope,
        ),
      );
      if (liveViewUrl.protocol !== 'https:' || liveViewUrl.hostname !== 'live.browser.run') {
        throw new Error('Invalid Live View capability origin');
      }
      liveViewUrl.searchParams.set('mode', 'tab');
      if (!(await repository.markHandoffCapabilityIssued(tenant, handoff.id))) {
        throw new Error('Unable to mark capability issued');
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: liveViewUrl.toString(),
          'cache-control': 'private, no-store',
          pragma: 'no-cache',
          'referrer-policy': 'no-referrer',
          'set-cookie': '__Host-handoff_exchange=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict',
        },
      });
    } catch {
      await provider.close(handoff.browserSessionId).catch(() => undefined);
      await repository.failHandoffBeforeIssue(tenant, handoff.approvalId, handoff.id);
      const coordinator = await connectionCoordinator(
        context.env,
        tenant.tenantId,
        handoff.connectionId,
      );
      await coordinator.stub.release(
        coordinator.ownerDigest,
        handoff.jobId,
        handoff.leaseGeneration,
      );
      return context.json(
        { error: { code: 'capability_unavailable', message: '人工交接能力無法安全簽發。' } },
        503,
      );
    }
  });

  return routes;
}
