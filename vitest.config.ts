import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

function testOutboundService(request: Request): Response {
  const url = new URL(request.url);
  if (
    url.origin !== 'https://graph.threads.net' ||
    url.pathname !== '/v1.0/profile_lookup' ||
    !['long-lived-secret-token', 'profile-lookup-token'].includes(
      url.searchParams.get('access_token') ?? '',
    )
  ) {
    return new Response(JSON.stringify({ error: { code: 10 } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  const username = url.searchParams.get('username') ?? '';
  return new Response(
    JSON.stringify({
      username,
      name: username === 'will.seed' ? 'Will Seed' : 'Candidate Name',
      biography: username === 'will.seed' ? 'Product studio' : undefined,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          SESSION_ENCRYPTION_KEY: 'ERERERERERERERERERERERERERERERERERERERERERE',
          COORDINATOR_NAMESPACE_KEY: 'test-only-coordinator-namespace-key-material',
          APP_ORIGIN: 'https://guard.example',
          META_APP_ID: 'test-meta-app-id',
          META_APP_SECRET: 'test-meta-app-secret',
          FEATURE_META_PROFILE_LOOKUP: 'true',
        },
        d1Databases: ['DB'],
        r2Buckets: ['EVIDENCE'],
        outboundService: testOutboundService,
      },
      wrangler: { configPath: './wrangler.jsonc' },
    })),
  ],
  test: {
    setupFiles: ['./tests/apply-migrations.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
