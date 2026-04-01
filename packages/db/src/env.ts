import { loadRuntimeEnvFile } from "@kirimail/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

loadRuntimeEnvFile(import.meta.url);

export const dbEnv = createEnv({
  server: { DATABASE_URL: z.url() },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
