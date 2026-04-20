/**
 * Vitest setupFile - runs in the test worker process BEFORE test module
 * imports. Creates a per-worker Postgres database from the `kirimail_test`
 * template pushed in globalSetup, then sets `process.env.DATABASE_URL` so
 * `createTestDb` in helpers.ts reads it without going through vitest's
 * `inject` plumbing.
 *
 * Each forked worker gets its own database (keyed by PID), so test files
 * can run in parallel without interfering via global DELETE statements.
 */
import { Pool } from "pg";
import { inject } from "vitest";

const postgresUrl = inject("postgresUrl");
const dbName = `kirimail_test_${process.pid}`;

const adminPool = new Pool({ connectionString: postgresUrl });
await adminPool.query(`CREATE DATABASE "${dbName}" TEMPLATE "kirimail_test"`);
await adminPool.end();

process.env.DATABASE_URL = postgresUrl.replace(/\/postgres$/, `/${dbName}`);
