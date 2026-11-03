import { defineConfig } from "vitest/config";

// `pnpm e2e`: real processes, real chain. One file, run in order: the final reconciliation covers
// every payment the earlier scenarios made.
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.ts"],
    globalSetup: ["src/global-setup.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
