import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

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
        },
        d1Databases: ['DB'],
        r2Buckets: ['EVIDENCE'],
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
