import { pool } from "@kirimail/db";
import { PgBoss } from "pg-boss";

import { closeCachedConnections } from "./caches";
import { workerEnv } from "./env";
import {
  registerAppendSent,
  registerEventDispatcher,
  registerImapCommand,
  registerOutboundReaper,
  registerSendMessage,
  registerSyncEmailAccount,
  registerSyncScheduler,
} from "./handlers";
import { IdlePool } from "./idle-pool";

/** Handle returned by {@link startWorkers} for lifecycle management. */
export interface WorkerHandle {
  /** Gracefully stop all workers and pg-boss. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Boot pg-boss, create queues, and register job handlers.
 *
 * Uses the shared Postgres pool from `@kirimail/db` so workers don't open a
 * second connection pool. Callers own signal handling - use the returned
 * {@link WorkerHandle.stop} to wire shutdown to SIGTERM or other signals.
 */
export async function startWorkers(): Promise<WorkerHandle> {
  const boss = new PgBoss({
    db: {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await pool.query(text, values);
        return { rows: result.rows };
      },
    },
    schema: "pgboss",
  });
  boss.on("error", (error) => console.error("[pg-boss]", error));
  boss.on("warning", ({ message, data }) => console.warn("[pg-boss]", message, data));
  await boss.start();

  // Queue registrations - stop boss if registration fails partway through.
  let idlePool: IdlePool | null = null;
  try {
    // event-dispatcher must register before sync-email-account: the sync
    // handler enqueues dispatcher ticks on success and boss.send fails for
    // a queue that doesn't exist.
    await registerEventDispatcher(boss);
    // sync-email-account must be registered before the idle pool starts
    // (the pool enqueues to this queue).
    await registerSyncEmailAccount(boss);
    await registerSyncScheduler(boss, workerEnv.SYNC_CRON_SCHEDULE);
    await registerImapCommand(boss);
    // append-sent must register before send-message, since send-message enqueues
    // append-sent on success and boss.send fails for a queue that doesn't exist.
    await registerAppendSent(boss);
    await registerSendMessage(boss);
    await registerOutboundReaper(boss);

    idlePool = new IdlePool(boss);
    await idlePool.startAll();
  } catch (err) {
    await idlePool?.stopAll().catch((e) => console.error("[workers] idle-pool cleanup:", e));
    await boss
      .stop({ graceful: true, timeout: 5_000 })
      .catch((e) => console.error("[workers] pg-boss cleanup:", e));
    try {
      closeCachedConnections();
    } catch (e) {
      console.error("[workers] imap-close cleanup:", e);
    }
    throw err;
  }

  // Graceful shutdown - caller owns signal handling (SIGTERM).
  // Order: stop IDLE (no new events) -> drain pg-boss (in-flight jobs finish)
  // -> close command connections (no longer needed).
  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    if (!stopPromise) {
      stopPromise = (async () => {
        await idlePool?.stopAll().catch((e) => console.error("[workers] idle-pool:", e));
        await boss
          .stop({ graceful: true, timeout: 15_000 })
          .catch((e) => console.error("[workers] pg-boss:", e));
        try {
          closeCachedConnections();
        } catch (e) {
          console.error("[workers] imap-close:", e);
        }
      })();
    }
    return stopPromise;
  };

  return { stop };
}
