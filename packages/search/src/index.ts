export type { Meilisearch } from "./client";
export type { BodyPartial, SyncedMessageDoc } from "./primitives";
export type { MessageDoc } from "./types";

export { createSearchClient, searchClient } from "./client";
export { ensureMeilisearchConfig, MESSAGES_INDEX_UID } from "./config";
export {
  deleteMessageDoc,
  deleteMessagesByEmailAccount,
  getMessageDoc,
  upsertMessageBody,
  upsertMessageFlags,
  upsertSyncedMessage,
} from "./primitives";

// Re-export meilisearch-js error classes so callers can run `instanceof`
// checks without taking a direct dependency on the underlying library.
export {
  MeilisearchApiError,
  MeilisearchError,
  MeilisearchRequestError,
  MeilisearchRequestTimeOutError,
  MeilisearchTaskTimeOutError,
} from "meilisearch";
