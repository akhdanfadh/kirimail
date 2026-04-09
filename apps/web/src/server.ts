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

// Our custom startup hook, gated by START_WORKERS_IN_PROCESS env.
//
// When "false", workers are not loaded and the web server runs standalone.
// Dynamic import avoids executing worker module code (pg-boss init,
// queue registration, worker env validation) when disabled.
if (webEnv.START_WORKERS_IN_PROCESS) {
  import("@kirimail/workers").then(({ startWorkers }) =>
    startWorkers()
      .then((handle) => {
        stop = handle.stop;
      })
      .catch((err) => {
        if (shuttingDown) return; // signal handler already owns cleanup
        shuttingDown = true;
        console.error("[workers] startup failed:", err);
        pool
          .end()
          .catch(console.error)
          .finally(() => process.exit(1));
      }),
  );
}

// TanStack Start server entry contract: export a { fetch } handler that
// Nitro's build plugin wires into the Node.js HTTP server it generates
// at .output/server/index.mjs. Every incoming request flows through here.
//
// @see https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point
export default createServerEntry({
  fetch: createStartHandler(defaultStreamHandler),
});
