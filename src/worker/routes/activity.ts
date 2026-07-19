import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnvironment } from '../environment';

const querySchema = z.object({
  connectionId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const activityRoutes = new Hono<AppEnvironment>();

activityRoutes.get('/', async (context) => {
  const parsed = querySchema.safeParse({
    connectionId: context.req.query('connectionId'),
    limit: context.req.query('limit'),
  });
  if (!parsed.success) {
    return context.json(
      { error: { code: 'invalid_request', message: '活動紀錄查詢條件無效。' } },
      400,
    );
  }
  const events = await context.get('repository').listAuditEvents(context.get('tenant'), {
    ...(parsed.data.connectionId ? { connectionId: parsed.data.connectionId } : {}),
    limit: parsed.data.limit,
  });
  return context.json({ events });
});
