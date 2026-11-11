import { defineConfig } from "vitest/config";

// Real Uniswap swap on an anvil fork of Base mainnet. Needs anvil on PATH and network access to
// FORK_RPC_URL (default https://mainnet.base.org). Slow; not part of the gate suite.
export default defineConfig({
  test: { include: ["test-fork/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});
