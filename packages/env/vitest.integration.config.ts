import { defineConfig } from "vitest/config";

// Store tests against real Postgres. They reuse the gateway's harness, because the gateway owns the
// migrations (db/migrations): one Postgres 16 per run (Testcontainers, or TEST_PG_URL), and each
// test gets its own database cloned from a migrated template.
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["../../apps/gateway/test/store/pg-global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
