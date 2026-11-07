import { defineConfig } from "vitest/config";

// Latency budgets (*.latency.ts). Kept out of the parallel unit run on purpose: they measure the
// hot path, and other test files competing for the CPU would make them flaky. One file at a time.
export default defineConfig({
  test: {
    include: ["test/**/*.latency.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
