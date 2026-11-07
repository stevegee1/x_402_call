import { defineConfig } from "vitest/config";

// Unit tests. The Postgres store tests (*.int.test.ts) run via vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.int.test.ts", "**/node_modules/**"],
  },
});
