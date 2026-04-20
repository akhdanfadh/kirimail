/**
 * Vitest setupFile - runs in the test worker process before any test imports.
 * Reads the shared Meilisearch container coordinates published by the
 * globalSetup and writes them into `process.env`.
 *
 * Per-worker isolation is achieved by tests using `TEST_INDEX_UID`
 * (defined in helpers.ts and keyed off `process.pid`) instead of the
 * production `MESSAGES_INDEX_UID` constant.
 */
import { inject } from "vitest";

process.env.MEILISEARCH_URL = inject("meilisearchUrl");
process.env.MEILI_MASTER_KEY = inject("meiliMasterKey");
