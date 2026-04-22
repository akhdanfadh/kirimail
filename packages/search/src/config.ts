import type { AttachmentMetadata } from "@kirimail/shared";
import type { Meilisearch, Settings } from "meilisearch";

import type { MessageDoc } from "./types";

import { awaitTaskOrThrow } from "./tasks";

/** Locked primary key for every document in {@link MESSAGES_INDEX_UID}. */
const PRIMARY_KEY = "id";

/** Index uid that holds one document per `messages.id`. */
export const MESSAGES_INDEX_UID = "messages";

/**
 * Field paths Meilisearch is allowed to index in any role
 * (searchable / filterable / sortable). `satisfies` against this union
 * turns name drift between {@link MessageDoc} and the settings below
 * into a compile error.
 */
type IndexableAttribute = keyof MessageDoc | `attachments.${keyof AttachmentMetadata}`;

/** Index settings applied by {@link ensureMeilisearchConfig}. */
const MESSAGES_INDEX_SETTINGS: Settings = {
  // Ordered by descending relevance - earlier entries weigh more in scoring, so reorder with care.
  // NOTE: any change here (reorder or set change) triggers a full reindex on next boot,
  // since Meilisearch re-tokenizes every document when searchableAttributes shifts.
  searchableAttributes: [
    "subject",
    "from",
    "to",
    "cc",
    "bcc",
    "attachments.filename",
    "bodyText",
  ] satisfies IndexableAttribute[],
  filterableAttributes: [
    "userId",
    "emailAccountId",
    "mailboxId",
    "receivedDate",
    "sizeBytes",
    "flags",
  ] satisfies IndexableAttribute[],
  sortableAttributes: ["receivedDate", "sizeBytes"] satisfies IndexableAttribute[],
  // NOTE: `displayedAttributes` left at default (`["*"]`) so `getDocument(id)`
  // can return body fields for the message-detail view (Meilisearch is the
  // body store). Search-query primitives must pass `attributesToRetrieve`
  // themselves to keep list-view payloads small; revisit if a per-endpoint
  // allowlist becomes necessary.
  // displayedAttributes: ...
};

/**
 * Idempotent startup routine: ensures the messages index exists with its
 * locked primary key and applies the canonical attribute settings.
 *
 * Safe to call on every boot - existing indexes pass through the
 * `index_already_exists` branch with a primary-key sanity check, and
 * `updateSettings` is itself idempotent. Failure surfaces as a thrown
 * error so the calling process exits non-zero rather than booting against
 * a misconfigured search store.
 */
export async function ensureMeilisearchConfig(
  client: Meilisearch,
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<void> {
  const createTask = await awaitTaskOrThrow(
    "createIndex",
    client.createIndex(indexUid, { primaryKey: PRIMARY_KEY }),
    { toleratedErrorCodes: ["index_already_exists"] },
  );
  if (createTask.status === "failed") {
    // Pre-existing index - verify its primary key matches what we lock here.
    // Catches bad migrations, manual tinkering, and operator restores from
    // a Meilisearch snapshot configured with a different key.
    const info = await client.index(indexUid).getRawInfo();
    if (info.primaryKey !== PRIMARY_KEY) {
      throw new Error(
        `[search] index "${indexUid}" expected primaryKey="${PRIMARY_KEY}", got ${info.primaryKey ?? "<unset>"}`,
      );
    }
  }

  await awaitTaskOrThrow(
    "updateSettings",
    client.index(indexUid).updateSettings(MESSAGES_INDEX_SETTINGS),
  );

  // NOTE: replace with structured logging once introduced.
  console.log(`[search] Meilisearch config ensured (index="${indexUid}")`);
}
