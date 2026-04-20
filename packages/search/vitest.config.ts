import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const logFile = resolve(import.meta.dirname, "test-output.log");
writeFileSync(logFile, "");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/__tests__/setup.ts"],
    setupFiles: ["src/__tests__/setup-env.ts"],
    testTimeout: 60_000,
    pool: "forks",
    onConsoleLog(log: string, type: "stdout" | "stderr") {
      appendFileSync(logFile, `[${type}] ${log}`);
      return false;
    },
  },
});
