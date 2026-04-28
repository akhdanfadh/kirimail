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

// NOTE: this index doubles as a search store (token index over headers + body)
// and a body content store (`bodyText`/`bodyHtml` retrieved via `getDocument` for
// the message-detail UI). When index size, restore-drill cost, or a need to expose
// the sender's original bytes (export, raw API, forensics) makes the split worth it,
// move authoritative body bytes to a dedicated store (Postgres column or future
// `packages/storage` object store) and shrink this index to search-only with a tight
// `displayedAttributes` allowlist covering only id + facet fields.

/** Index settings applied by {@link ensureMeilisearchConfig}. */
const MESSAGES_INDEX_SETTINGS: Settings = {
  // Ordered by descending relevance - earlier entries weigh more in scoring, so reorder with care.
  // NOTE: searchableAttributes changes (reorder or set change) re-tokenize every document on
  // next boot - Meilisearch rebuilds the inverted index. filterableAttributes changes are
  // cheaper (they rebuild facet databases only, not the inverted index) but still scan all
  // documents at startup; not free at scale.
  searchableAttributes: [
    "subject",
    "from",
    "to",
    "cc",
    "bcc",
    "attachments.filename",
    "bodyText",
    // Only one of `bodyText` / `bodyTextDerived` is ever populated per doc
    // (the worker derives only when no text/plain part existed), so ordering
    // between these two has no operational effect on relevance.
    "bodyTextDerived",
  ] satisfies IndexableAttribute[],
  filterableAttributes: [
    "userId",
    "emailAccountId",
    "mailboxId",
    "receivedDate",
    "sizeBytes",
    "flags",
    "encrypted",
  ] satisfies IndexableAttribute[],
  sortableAttributes: ["receivedDate", "sizeBytes"] satisfies IndexableAttribute[],
  // Explicit allowlist for `displayedAttributes` (by default it is `["*"]`):
  // `bodyTextDerived` is searchable but omitted here so search responses and
  // `_formatted` snippets never leak it. (See `MessageDoc` for the data-shape
  // rationale and the `getDocument` caveat.) Cheap to change: `displayedAttributes`
  // is a retrieval-time filter, not an indexing-time one - no re-tokenization on update.
  displayedAttributes: [
    "id",
    "userId",
    "emailAccountId",
    "mailboxId",
    "subject",
    "from",
    "to",
    "cc",
    "bcc",
    "receivedDate",
    "sizeBytes",
    "flags",
    "encrypted",
    "attachments",
    "bodyText",
    "bodyHtml",
  ] satisfies IndexableAttribute[],
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
