import { Hono } from 'hono';
import { z } from 'zod';

import { generateCandidateVariants, VARIANT_RULES } from '../../domain/candidates';
import { parseUsername } from '../../domain/usernames';
import {
  CandidateAlreadyExistsError,
  TenantAuthorizationError,
} from '../../platform/d1/repository';
import type { AppEnvironment } from '../environment';

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
