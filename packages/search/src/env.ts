import { loadRuntimeEnvFile } from "@kirimail/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

loadRuntimeEnvFile(import.meta.url);

export const searchEnv = createEnv({
  server: {
    /** Base URL of the Meilisearch server (no trailing slash needed). */
    MEILISEARCH_URL: z.url(),
    /**
     * Master API key used to authenticate every request from this client.
     * Must be at least 16 bytes when Meilisearch runs with `MEILI_ENV=production`;
     * dev mode accepts shorter keys but the same minimum is enforced here so
     * dev and prod env files stay interchangeable.
     */
    MEILI_MASTER_KEY: z.string().min(16),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
