/**
 * Standalone entry point for running workers in a separate container.
 *
 * Same Docker image, different CMD:
 *   CMD ["node", "--import", "tsx", "apps/workers/src/standalone.ts"]
 *
 * The process stays alive via pg-boss polling. Signal handlers are
 * registered early so Ctrl+C during startup still cleans up. Once
 * running, shutdown stops pg-boss gracefully then closes the pool.
 */
import { pool } from "@kirimail/db";

import { startWorkers } from "./index.js";

let stop: (() => Promise<void>) | undefined;
let shuttingDown = false;

// Register early so signals during startup still close the pool cleanly.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    (stop?.() ?? Promise.resolve())
      .catch(console.error)
      .finally(() => pool.end().catch(console.error))
      .finally(() => process.exit(0));
  });
}

try {
  ({ stop } = await startWorkers());
} catch (err) {
  console.error("[workers] startup failed", err);
  await pool.end().catch(console.error);
  process.exit(1);
}
