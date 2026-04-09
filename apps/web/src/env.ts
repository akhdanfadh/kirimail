import { loadRuntimeEnvFile } from "@kirimail/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

loadRuntimeEnvFile(import.meta.url);

export const webEnv = createEnv({
  server: {
    /**
     * Boot workers in the web server process.
     * Default to true for dev. Set otherwise if run in a separate container.
     */
    START_WORKERS_IN_PROCESS: z.stringbool().default(true),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
