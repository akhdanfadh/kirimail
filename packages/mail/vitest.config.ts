import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const logFile = resolve(import.meta.dirname, "test-output.log");
writeFileSync(logFile, "");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/__tests__/setup.ts"],
    testTimeout: 60_000,
    onConsoleLog(log: string, type: "stdout" | "stderr") {
      appendFileSync(logFile, `[${type}] ${log}`);
      return false;
    },
  },
});
