import { createEnv } from "@t3-oss/env-core";
import { loadRuntimeEnvFile } from "@inbok/env";
import { z } from "zod";

loadRuntimeEnvFile(import.meta.url);

export const serverEnv = createEnv({
  server: {
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
