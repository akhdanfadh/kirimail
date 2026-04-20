/**
 * Per-pid index uid that isolates each forked vitest worker's writes from
 * every other worker's. Tests pass this in place of the production
 * `MESSAGES_INDEX_UID` constant so a single shared Meilisearch container
 * can serve all workers without cross-pollution.
 */
export const TEST_INDEX_UID = `messages_${process.pid}`;
