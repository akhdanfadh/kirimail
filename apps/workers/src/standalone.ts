/**
 * Standalone entry point for running workers in a separate container.
 *
 * Same Docker image, different CMD:
 *   CMD ["node", "apps/workers/dist/standalone.mjs"]
 *
 * A minimal HTTP health endpoint reports DB connectivity for Docker
 * healthchecks (port configurable via WORKER_HEALTH_PORT, default 3005).
 */
import { pool } from "@kirimail/db";
import { createServer } from "node:http";

import { workerEnv } from "./env";
import { startWorkers } from "./index";

let stop: (() => Promise<void>) | undefined;
let shuttingDown = false;
let ready = false;

// Health endpoint starts before workers so Docker gets 503 (not ready)
// instead of connection refused during startup.
const healthServer = createServer(async (_req, res) => {
  try {
    if (!ready || shuttingDown) throw new Error("not ready");
    await pool.query("SELECT 1");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } catch {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error" }));
  }
});

healthServer.listen(workerEnv.WORKER_HEALTH_PORT, () => {
  console.log(`[workers] health endpoint listening on :${workerEnv.WORKER_HEALTH_PORT}`);
});

// Register before workers so signals during startup still close the pool cleanly.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    healthServer.close();
    (stop?.() ?? Promise.resolve())
      .catch(console.error)
      .finally(() => pool.end().catch(console.error))
      .finally(() => process.exit(0));
  });
}

try {
  ({ stop } = await startWorkers());
  ready = true;
} catch (err) {
  console.error("[workers] startup failed", err);
  healthServer.close();
  await pool.end().catch(console.error);
  process.exit(1);
}
