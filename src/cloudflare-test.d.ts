import type { applyD1Migrations } from 'cloudflare:test';

type TestD1Migrations = Parameters<typeof applyD1Migrations>[1];

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: TestD1Migrations;
    }
  }
}

export {};
