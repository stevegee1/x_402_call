import { defineConfig } from "vitest/config";

// Unit + in-process e2e tests. Postgres integration tests (*.int.test.ts) need Docker and run via
// vitest.integration.config.ts (`pnpm test:integration`).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.int.test.ts", "**/node_modules/**"],
  },
});
