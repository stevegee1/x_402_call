import { defineConfig } from "vitest/config";

// Fast unit tests of the harness's own logic (the reconciler), run with the rest of `pnpm test`.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
