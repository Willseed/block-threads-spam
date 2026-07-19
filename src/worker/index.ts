import { Hono } from 'hono';

export const app = new Hono();

app.get('/api/health', (context) =>
  context.json({
    service: 'threads-variant-guard',
    status: 'ok',
  }),
);

export default app;
