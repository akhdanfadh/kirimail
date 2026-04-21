export type { Meilisearch } from "./client";
export type { BodyPartial, HeaderDoc } from "./primitives";
export type { MessageDoc, AttachmentMeta } from "./types";

export { createSearchClient, searchClient } from "./client";
export { ensureMeilisearchConfig } from "./config";
export {
  deleteMessageDoc,
  deleteMessagesByEmailAccount,
  getMessageDoc,
  upsertMessageAttachments,
  upsertMessageBody,
  upsertMessageHeaders,
} from "./primitives";
