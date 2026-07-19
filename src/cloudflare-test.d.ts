import type { applyD1Migrations } from 'cloudflare:test';
import type { ConnectionCoordinator } from './durable-objects/connection-coordinator';

type TestD1Migrations = Parameters<typeof applyD1Migrations>[1];

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      EVIDENCE: R2Bucket;
      CONNECTION_COORDINATOR: DurableObjectNamespace<ConnectionCoordinator>;
      TEST_MIGRATIONS: TestD1Migrations;
    }
  }
}

export {};
