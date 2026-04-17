/**
 * Standalone migration runner for production deployments.
 *
 * Applies pending Drizzle SQL migrations then exits. Designed to run as a
 * one-shot Docker Compose service before web/workers start.
 *
 * Uses a direct pg.Client (not a Pool) so the advisory lock stays on the
 * same session for the entire migration run. Drizzle's migrate() has no
 * built-in concurrency protection, so the lock prevents races if multiple
 * processes call migrate() at once.
 * @see: https://github.com/drizzle-team/drizzle-orm/issues/874
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { dbEnv } from "./env";

const client = new pg.Client({ connectionString: dbEnv.DATABASE_URL });
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

let exitCode = 0;
let locked = false;
try {
  await client.connect();
  // Scoped timeout: fail fast if the advisory lock is stuck, then remove the
  // limit so migration DDL (e.g. CREATE INDEX) can run as long as it needs.
  await client.query("SET statement_timeout = '30s'");
  await client.query("SELECT pg_advisory_lock(hashtext('drizzle_migration'))");
  locked = true;
  await client.query("SET statement_timeout = 0");
  await migrate(drizzle({ client }), { migrationsFolder });
  console.log("[migrate] done");
} catch (err) {
  console.error("[migrate] failed:", err);
  exitCode = 1;
} finally {
  if (locked) {
    await client.query("SELECT pg_advisory_unlock(hashtext('drizzle_migration'))").catch(() => {});
  }
  await client.end().catch(() => {});
}
process.exitCode = exitCode;
