/**
 * Vitest setupFile - runs in the test worker process BEFORE test module
 * imports. Bridges inject() values from global setup to process.env so
 * module-level singletons (db from @kirimail/db, mailEnv from @kirimail/mail)
 * read from the test containers.
 *
 * Works because @kirimail/env uses dotenv({ override: false }) - env vars
 * set here take precedence over .env files.
 */
import { inject } from "vitest";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.CREDENTIAL_ENCRYPTION_KEY = inject("encryptionKey");
