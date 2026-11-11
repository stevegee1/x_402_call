import { defineConfig } from "vitest/config";

// Unit tests only. The real-swap test against a Base mainnet fork is `pnpm test:fork` (needs anvil).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
