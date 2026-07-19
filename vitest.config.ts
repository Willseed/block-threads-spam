import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
        d1Databases: ['DB'],
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
