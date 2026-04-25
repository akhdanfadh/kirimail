/**
 * Vitest setupFile - runs in the test worker process BEFORE test module
 * imports. Creates a per-worker Postgres database from the template pushed
 * in globalSetup, then sets process.env so module-level singletons
 * (db from @kirimail/db, mailEnv from @kirimail/mail) read from it.
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
process.env.CREDENTIAL_ENCRYPTION_KEY = inject("encryptionKey");
// Must be set before any test-file import chain reaches @kirimail/search,
// which builds a module-level `searchClient` from these values at import time.
process.env.MEILISEARCH_URL = inject("meilisearchUrl");
process.env.MEILI_MASTER_KEY = inject("meiliMasterKey");
