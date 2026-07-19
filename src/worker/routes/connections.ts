import { Hono } from 'hono';
import { z } from 'zod';

import { generateCandidateVariants, VARIANT_RULES } from '../../domain/candidates';
import { assessProfileSimilarity } from '../../domain/similarity';
import { parseUsername } from '../../domain/usernames';
import {
  CandidateAlreadyExistsError,
  TenantAuthorizationError,
} from '../../platform/d1/repository';
import { R2EvidenceRepository } from '../../platform/r2/evidence-repository';
import type { AppEnvironment } from '../environment';
import { connectionCoordinator } from '../coordinator';
import { requireRecentAuthentication } from '../identity/reauthentication';

const connectionInput = z.object({
  protectedUsername: z.string().min(1).max(31),
  connectionMode: z.enum(['meta_oauth', 'manual_handoff']).default('meta_oauth'),
});

const candidateInput = z.object({
  username: z.string().min(1).max(31),
});

const generationInput = z.object({
  enabledRules: z.array(z.enum(VARIANT_RULES)).max(VARIANT_RULES.length).optional(),
  totalLimit: z.number().int().min(1).max(100).default(80),
  perRuleLimit: z.number().int().min(1).max(20).default(12),
});

const revocationInput = z.object({
  dataRetention: z.enum(['retain', 'delete']),
});

function validationError() {
  return {
    error: {
      code: 'invalid_request',
      message: '請檢查帳號名稱與要求內容。',
    },
  };
}

export const connectionRoutes = new Hono<AppEnvironment>();

connectionRoutes.get('/', async (context) => {
  const connections = await context.get('repository').listConnections(context.get('tenant'));
  return context.json({ connections });
});

connectionRoutes.post('/', async (context) => {
  const body: unknown = await context.req.json().catch(() => undefined);
  const parsed = connectionInput.safeParse(body);
  if (!parsed.success) return context.json(validationError(), 400);

  let protectedUsername: string;
  try {
    protectedUsername = parseUsername(parsed.data.protectedUsername);
  } catch {
    return context.json(validationError(), 400);
  }

  const connection = await context
    .get('repository')
    .createConnection(context.get('tenant'), protectedUsername, parsed.data.connectionMode);
  return context.json({ connection }, 201);
});

connectionRoutes.delete('/:connectionId', requireRecentAuthentication, async (context) => {
  const body: unknown = await context.req.json().catch(() => undefined);
  const parsed = revocationInput.safeParse(body);
  if (!parsed.success) return context.json(validationError(), 400);

  const tenant = context.get('tenant');
  const repository = context.get('repository');
  const connectionId = context.req.param('connectionId');
  const connection = await repository.beginConnectionRevocation(tenant, connectionId);
  if (!connection) {
    return context.json(
      { error: { code: 'not_found', message: '找不到指定的 Threads 連線。' } },
      404,
    );
  }
  const deleteRetainedData = parsed.data.dataRetention === 'delete';

  if (connection.status === 'revoked') {
    if (deleteRetainedData) {
      const evidence = new R2EvidenceRepository(context.env.DB, context.env.EVIDENCE);
      await evidence.purgeConnection(tenant, connectionId);
      const updated = await repository.completeConnectionRevocation(
        tenant,
        connectionId,
        connection.revocationVersion,
        true,
      );
      return context.json({ connection: updated });
    }
    return context.json({ connection });
  }

  let coordinator;
  try {
    coordinator = await connectionCoordinator(context.env, tenant.tenantId, connectionId);
  } catch {
    return context.json(
      { error: { code: 'service_unavailable', message: '目前無法安全中斷 Threads 連線。' } },
      503,
    );
  }
  const nextVersion = await coordinator.stub.revoke(
    coordinator.ownerDigest,
    connection.revocationVersion,
  );
  if (nextVersion === undefined) {
    return context.json(
      { error: { code: 'revocation_conflict', message: '連線狀態已變更，請重新載入。' } },
      409,
    );
  }

  try {
    if (deleteRetainedData) {
      const evidence = new R2EvidenceRepository(context.env.DB, context.env.EVIDENCE);
      await evidence.purgeConnection(tenant, connectionId);
    }
    const revoked = await repository.completeConnectionRevocation(
      tenant,
      connectionId,
      nextVersion,
      deleteRetainedData,
    );
    return context.json({ connection: revoked });
  } catch {
    return context.json(
      {
        error: {
          code: 'revocation_pending',
          message: '憑證已失效，資料清理仍在進行；請稍後重試。',
        },
      },
      503,
    );
  }
});

connectionRoutes.get('/:connectionId/candidates', async (context) => {
  const candidates = await context
    .get('repository')
    .listCandidates(context.get('tenant'), context.req.param('connectionId'));
  return context.json({ candidates });
});

connectionRoutes.post('/:connectionId/candidates', async (context) => {
  const body: unknown = await context.req.json().catch(() => undefined);
  const parsed = candidateInput.safeParse(body);
  if (!parsed.success) return context.json(validationError(), 400);

  let username: string;
  try {
    username = parseUsername(parsed.data.username);
  } catch {
    return context.json(validationError(), 400);
  }

  try {
    const candidate = await context.get('repository').addCandidate(
      context.get('tenant'),
      context.req.param('connectionId'),
      {
        username,
        sourceType: 'manual',
        sourceRules: [],
        reasons: ['使用者人工加入完整帳號名稱'],
      },
    );
    return context.json({ candidate }, 201);
  } catch (error) {
    if (error instanceof CandidateAlreadyExistsError) {
      return context.json(
        { error: { code: 'candidate_exists', message: '這個候選已在清單中。' } },
        409,
      );
    }
    if (error instanceof TenantAuthorizationError) {
      return context.json(
        { error: { code: 'not_found', message: '找不到指定的 Threads 連線。' } },
        404,
      );
    }
    throw error;
  }
});

connectionRoutes.post('/:connectionId/candidates/generate', async (context) => {
  const body: unknown = await context.req.json().catch(() => ({}));
  const parsed = generationInput.safeParse(body);
  if (!parsed.success) return context.json(validationError(), 400);

  const tenant = context.get('tenant');
  const repository = context.get('repository');
  const connectionId = context.req.param('connectionId');
  const connection = await repository.getConnection(tenant, connectionId);
  if (!connection || connection.status === 'revoked') {
    return context.json(
      { error: { code: 'not_found', message: '找不到指定的 Threads 連線。' } },
      404,
    );
  }

  const variants = generateCandidateVariants(connection.protectedUsername, parsed.data);
  const created = await repository.addGeneratedCandidates(
    tenant,
    connectionId,
    variants.map((variant) => ({
      username: variant.username,
      sourceType: 'generated',
      sourceRules: variant.rules,
      reasons: variant.reasons,
    })),
  );
  const candidates = await repository.listCandidates(tenant, connectionId);

  return context.json({
    snapshot: {
      generated: variants.length,
      created,
      limits: {
        total: parsed.data.totalLimit,
        perRule: parsed.data.perRuleLimit,
      },
    },
    candidates,
  });
});

connectionRoutes.post('/:connectionId/candidates/:candidateId/refresh', async (context) => {
  if (context.env.FEATURE_META_PROFILE_LOOKUP !== 'true') {
    return context.json(
      { error: { code: 'capability_unavailable', message: 'Threads 個人檔案查詢目前未啟用。' } },
      503,
    );
  }
  const tenant = context.get('tenant');
  const repository = context.get('repository');
  const connectionId = context.req.param('connectionId');
  const candidateId = context.req.param('candidateId');
  const [connection, candidate] = await Promise.all([
    repository.getConnection(tenant, connectionId),
    repository.getCandidate(tenant, connectionId, candidateId),
  ]);
  if (!connection || !candidate) {
    return context.json(
      { error: { code: 'not_found', message: '找不到指定的候選帳號。' } },
      404,
    );
  }
  if (connection.status !== 'connected') {
    return context.json(
      { error: { code: 'connection_required', message: '請先完成 Threads 帳號連線。' } },
      409,
    );
  }

  let coordinator;
  try {
    coordinator = await connectionCoordinator(context.env, tenant.tenantId, connectionId);
  } catch {
    return context.json(
      { error: { code: 'service_unavailable', message: 'Threads 查詢目前無法使用。' } },
      503,
    );
  }
  const jobId = `refresh-${crypto.randomUUID()}`;
  const lease = await coordinator.stub.acquire({
    ownerDigest: coordinator.ownerDigest,
    revocationVersion: connection.revocationVersion,
    jobId,
    kind: 'candidate_refresh',
    ttlSeconds: 60,
  });
  if (lease.status !== 'acquired') {
    return context.json(
      { error: { code: 'connection_busy', message: '這個帳號已有工作進行中。' } },
      409,
    );
  }

  try {
    const lookup = await coordinator.stub.lookupProfile(coordinator.ownerDigest, candidate.username);
    const update =
      lookup.status === 'found'
        ? {
            status: 'found' as const,
            profile: lookup.profile,
            assessment: assessProfileSimilarity(
              { username: connection.protectedUsername },
              {
                username: lookup.profile.username,
                ...(lookup.profile.displayName
                  ? { displayName: lookup.profile.displayName }
                  : {}),
                ...(lookup.profile.biography ? { bio: lookup.profile.biography } : {}),
              },
            ),
          }
        : lookup;
    const updatedCandidate = await repository.recordCandidateLookup(
      tenant,
      connectionId,
      candidateId,
      update,
    );
    return context.json({ lookup, candidate: updatedCandidate });
  } finally {
    await coordinator.stub.release(coordinator.ownerDigest, jobId, lease.generation);
  }
});
