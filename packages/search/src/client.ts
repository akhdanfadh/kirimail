import type { Config } from "meilisearch";

import { Meilisearch } from "meilisearch";

import { searchEnv } from "./env";

/** Build a Meilisearch client with arbitrary config. */
export function createSearchClient(config: Config): Meilisearch {
  return new Meilisearch(config);
}

/**
 * Process-wide Meilisearch client built from validated env. One shared
 * instance per process so connection keep-alive and HTTP agent state
 * aren't duplicated across call sites.
 */
export const searchClient = createSearchClient({
  host: searchEnv.MEILISEARCH_URL,
  apiKey: searchEnv.MEILI_MASTER_KEY,
});

export type { Meilisearch } from "meilisearch";
