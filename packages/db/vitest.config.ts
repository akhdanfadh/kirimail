import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "#test": resolve(import.meta.dirname, "src/__tests__") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/__tests__/setup.ts"],
    setupFiles: ["src/__tests__/setup-env.ts"],
    testTimeout: 60_000,
    // setup-env.ts keys per-worker databases off `process.pid`, so each
    // test file needs its own process. "forks" provides that and matches
    // apps/workers which shares the same template-database pattern.
    pool: "forks",
  },
});
