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
