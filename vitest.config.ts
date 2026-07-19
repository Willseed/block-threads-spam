import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';

const testEnvDefaults = {
  TEAM_DOMAIN: 'https://team-test.cloudflareaccess.com',
  POLICY_AUD: 'test-policy-audit-audience',
  APP_ORIGIN: 'https://guard.example',
  SESSION_ENCRYPTION_KEY: 'ERERERERERERERERERERERERERERERERERERERERERE',
  COORDINATOR_NAMESPACE_KEY: 'test-only-coordinator-namespace-key-material',
  META_APP_ID: 'test-meta-app-id',
  META_APP_SECRET: 'test-meta-app-secret',
};

const testEnv = process.env as Record<string, string | undefined>;

for (const [key, value] of Object.entries(testEnvDefaults)) {
  testEnv[key] ??= value;
}

const wranglerLogPath = path.join(process.cwd(), '.wrangler-vitest', 'logs', 'wrangler.log');
testEnv.WRANGLER_LOG_PATH ??= wranglerLogPath;
fs.mkdirSync(path.dirname(testEnv.WRANGLER_LOG_PATH), { recursive: true });
testEnv.WRANGLER_WRITE_LOGS ??= '0';

function testOutboundService(request: Request): Response {
  const url = new URL(request.url);
  if (
    url.origin !== 'https://graph.threads.net' ||
    url.pathname !== '/v1.0/profile_lookup' ||
    !['long-lived-secret-token', 'profile-lookup-token', 'scheduled-profile-token'].includes(
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
      id: `platform-${username}`,
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
          FEATURE_MANUAL_BLOCK_HANDOFF: 'true',
          FEATURE_BROWSER_LIVE_VIEW: 'true',
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
