/**
 * TanStack Start custom server entry point.
 *
 * NOTE: On lifecycle (server startup/shutdown) hooks, Nitro plugins
 * support startup (plugin body) and shutdown (`close` hook), but
 * `close` doesn't fire on the Node.js preset (https://github.com/nitrojs/nitro/issues/4015).
 * Rather than split startup into a Nitro plugin and shutdown into a signal handler,
 * we keep both here as module-level side effects. Once #4015 is fixed,
 * both can move into a single Nitro plugin.
 *
 * @see https://nitro.build/docs/plugins
 */

import { pool } from "@kirimail/db";
import { ensureMeilisearchConfig, searchClient } from "@kirimail/search";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

import { webEnv } from "./env";

let stop: (() => Promise<void>) | undefined;
let shuttingDown = false;

// Our custom shutdown hook.
//
// We handle SIGTERM/SIGINT ourselves so in-flight requests are
// killed on process.exit - no drain. This should also be registered
// before our custom startup hook below so signals during startup
// still clean up without hanging on the workers promise.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${sig} received, shutting down`);
    (stop?.() ?? Promise.resolve())
      .catch(console.error)
      .finally(() => pool.end().catch(console.error))
      .finally(() => process.exit(0));
  });
}

// Search infra is awaited at the module top level to fail-fast on
// misconfiguration (bad env, wrong primary key, auth error) - those don't
// self-heal, so crash at boot instead of surfacing as 5xx on first query.
try {
  await ensureMeilisearchConfig(searchClient);
} catch (err) {
  if (!shuttingDown) {
    shuttingDown = true;
    console.error("[server] startup failed:", err);
    await pool.end().catch(console.error);
    process.exit(1);
  } else {
    // Signal handler owns cleanup; still log so a real misconfig isn't masked.
    console.error("[server] startup failed during shutdown:", err);
  }
}

// Workers boot in the background so the fetch export doesn't wait on
// IdlePool.startAll() (one IMAP handshake per active account - can stretch
// past readiness-probe grace on large account sets). Partial worker
// availability while web serves is acceptable: background processing just
// starts slightly late.
//
// Dynamic import keeps its module code out of the standalone web path when false.
// The !shuttingDown guard avoids booting workers if a signal raced startup.
if (!shuttingDown && webEnv.START_WORKERS_IN_PROCESS) {
  import("@kirimail/workers")
    .then(({ startWorkers }) => startWorkers())
    .then((handle) => {
      stop = handle.stop;
    })
    .catch((err) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error("[workers] startup failed:", err);
      pool
        .end()
        .catch(console.error)
        .finally(() => process.exit(1));
    });
}

// TanStack Start server entry contract: export a { fetch } handler that
// Nitro's build plugin wires into the Node.js HTTP server it generates
// at .output/server/index.mjs. Every incoming request flows through here.
//
// @see https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point
export default createServerEntry({
  fetch: createStartHandler(defaultStreamHandler),
});
