import { defineConfig } from "vitest/config";

// Latency budgets (*.latency.ts), run one file at a time so other tests don't compete for the CPU.
export default defineConfig({
  test: {
    include: ["test/**/*.latency.ts"],
    fileParallelism: false,
  },
});
