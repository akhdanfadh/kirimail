/**
 * TanStack Start custom server entry point.
 *
 * Boots background workers in-process (single Node.js process) and
 * wires explicit shutdown on SIGTERM/SIGINT. Workers are required -
 * if they fail to start, the process exits (but the server may briefly
 * accept requests during the async startup window).
 */
import { pool } from "@kirimail/db";
import { startWorkers } from "@kirimail/workers";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

let stop: (() => Promise<void>) | undefined;
let shuttingDown = false;

// Register signal handlers before startWorkers() so SIGTERM during
// startup doesn't hang waiting for the workers promise to resolve.
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

// NOTE: Module-level side effect - not idiomatic for TanStack Start server
// entries (normally pure exports). Works because the Nitro Node.js preset
// loads server.ts once at boot. May break if TanStack Start changes module
// loading semantics (Vinxi was already removed in v1.121; the build pipeline
// is now direct Vite + Nitro and actively decoupling further).
//
// Nitro plugins are NOT a viable fallback: plugin bodies are synchronous
// (can't await startWorkers), and the `close` hook doesn't fire on the
// Node.js preset (https://github.com/nitrojs/nitro/issues/4015). If module
// loading changes, top-level await (if supported) or a framework startup
// hook (if one is added) would be the correct migration path.
//
// @see https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point - server.ts contract
// @see https://github.com/TanStack/router/discussions/3265 - Vinxi removal discussion
// @see https://github.com/nitrojs/nitro/issues/915 - no async plugin support
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
  });

// NOTE: createServerEntry is a pure request handler wrapper - no lifecycle
// hooks. In-flight requests are killed on process.exit because neither
// TanStack Start nor Nitro expose an HTTP drain mechanism. Nitro's `close`
// hook would be the closest thing, but it doesn't fire on the Node.js
// preset (https://github.com/nitrojs/nitro/issues/4015). Drain coordination
// requires framework-level support that doesn't exist yet.
// @see https://nitro.build/guide/plugins#hooks - Nitro lifecycle hooks (no pre-close drain)
export default createServerEntry({
  fetch: createStartHandler(defaultStreamHandler),
});
