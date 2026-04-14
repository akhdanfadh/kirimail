import { pool } from "@kirimail/db";
import { PgBoss } from "pg-boss";

import { workerEnv } from "./env";
import { registerImapCommand } from "./imap-command";
import { registerSync } from "./sync";

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

  // Graceful shutdown - caller owns signal handling (SIGTERM)
  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    if (!stopPromise) {
      stopPromise = boss.stop({ graceful: true, timeout: 15_000 });
    }
    return stopPromise;
  };

  // Queue registrations - stop boss if registration fails partway through
  try {
    await registerSync(boss, workerEnv.SYNC_CRON_SCHEDULE);
    await registerImapCommand(boss);
  } catch (err) {
    await boss.stop({ graceful: true, timeout: 5_000 }).catch(console.error);
    throw err;
  }

  return { stop };
}
