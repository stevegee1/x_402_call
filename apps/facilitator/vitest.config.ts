import { defineConfig } from "vitest/config";

// Unit tests only. Tests against a real chain (anvil) live in /e2e and run via `pnpm e2e`.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
