import { loadRuntimeEnvFile } from "@kirimail/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

loadRuntimeEnvFile(import.meta.url);

export const mailEnv = createEnv({
  server: {
    /** 64 hex characters (32 bytes) for AES-256-GCM credential encryption. */
    CREDENTIAL_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, "Must be 64 hex characters (32 bytes for AES-256)"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
