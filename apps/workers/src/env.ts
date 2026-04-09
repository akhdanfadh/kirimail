import { loadRuntimeEnvFile } from "@kirimail/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

loadRuntimeEnvFile(import.meta.url);

export const workerEnv = createEnv({
  server: {
    /**
     * Cron schedule for incremental sync (5-field, minute precision).
     * Syntax validated by pg-boss at `boss.schedule()` - invalid cron fails on boot.
     */
    SYNC_CRON_SCHEDULE: z.string().default("*/15 * * * *"),
    /** HTTP port for the Docker healthcheck endpoint in standalone mode. */
    WORKER_HEALTH_PORT: z.coerce.number().default(3005),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
