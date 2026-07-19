import { Hono } from 'hono';

import { R2EvidenceRepository } from '../../platform/r2/evidence-repository';
import type { AppEnvironment } from '../environment';
import { requireRecentAuthentication } from '../identity/reauthentication';

export const evidenceRoutes = new Hono<AppEnvironment>();

evidenceRoutes.use('*', requireRecentAuthentication);

evidenceRoutes.get('/:evidenceId', async (context) => {
  const repository = new R2EvidenceRepository(context.env.DB, context.env.EVIDENCE);
  const evidence = await repository.get(context.get('tenant'), context.req.param('evidenceId'));
  if (!evidence) {
    return context.json({ error: { code: 'not_found', message: '找不到指定的證據。' } }, 404);
  }

  return new Response(evidence.body, {
    headers: {
      'cache-control': 'private, no-store',
      'content-length': String(evidence.byteLength),
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      'content-type': evidence.contentType,
      etag: `"sha256-${evidence.sha256}"`,
      'x-content-type-options': 'nosniff',
    },
  });
});

evidenceRoutes.delete('/:evidenceId', async (context) => {
  const repository = new R2EvidenceRepository(context.env.DB, context.env.EVIDENCE);
  const deleted = await repository.delete(context.get('tenant'), context.req.param('evidenceId'));
  if (!deleted) {
    return context.json({ error: { code: 'not_found', message: '找不到指定的證據。' } }, 404);
  }
  return context.body(null, 204);
});
