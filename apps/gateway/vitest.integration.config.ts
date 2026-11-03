import { defineConfig } from "vitest/config";

// Integration tests against a real Postgres 16 started by Testcontainers (requires a Docker daemon).
// One container per run (globalSetup); every test gets its own database cloned from a migrated template.
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/store/pg-global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
