import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/__tests__/setup.ts"],
    testTimeout: 60_000,
  },
});
