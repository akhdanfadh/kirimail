import type { Meilisearch } from "meilisearch";

import { MeilisearchApiError } from "meilisearch";

import type { AttachmentMeta, MessageDoc } from "./types";

import { MESSAGES_INDEX_UID } from "./config";
import { awaitTaskOrThrow } from "./tasks";

// NOTE: the orphan hazard flagged on `upsertMessageAttachments` and
// `upsertMessageBody` (partial updates against a missing id) is closed
// at the caller layer - the dispatcher should serialize per-message-id
// processing (pg-boss `singletonKey: message.id`) so a concurrent
// message.deleted can't race against a partial write. Without that
// guarantee, orphans are possible and need a scheduled sweep
// (`emailAccountId NOT EXISTS` filter) to reconcile.

/** The required-field subset of {@link MessageDoc} written at the header stage. */
export type HeaderDoc = Omit<MessageDoc, "attachments" | "bodyText" | "bodyHtml">;

/** The body-field subset of {@link MessageDoc} written at the body-fetch stage. */
export type BodyPartial = Pick<MessageDoc, "bodyText" | "bodyHtml">;

/**
 * Header-stage upsert, covering every field in {@link HeaderDoc} (including
 * `flags`). Partial-merge via `updateDocuments` so re-runs preserve
 * later-stage fields (attachments, body).
 */
export async function upsertMessageHeaders(
  client: Meilisearch,
  doc: HeaderDoc,
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<void> {
  await awaitTaskOrThrow(
    "upsertMessageHeaders",
    client.index<MessageDoc>(indexUid).updateDocuments([doc]),
  );
}

/**
 * Attachment-stage partial upsert.
 *
 * Caller invariant: the document must already exist (created via
 * {@link upsertMessageHeaders}). Calling this on a missing id creates an
 * orphan `{id, attachments}` doc - invisible to tenant-scoped queries
 * and unreachable by {@link deleteMessagesByEmailAccount}.
 */
export async function upsertMessageAttachments(
  client: Meilisearch,
  id: string,
  attachments: AttachmentMeta[],
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<void> {
  await awaitTaskOrThrow(
    "upsertMessageAttachments",
    client.index<MessageDoc>(indexUid).updateDocuments([{ id, attachments }]),
  );
}

/**
 * Body-stage partial upsert.
 *
 * Caller invariant: the document must already exist (created via
 * {@link upsertMessageHeaders}). Calling this on a missing id creates an
 * orphan doc - invisible to tenant-scoped queries and unreachable by
 * {@link deleteMessagesByEmailAccount}.
 */
export async function upsertMessageBody(
  client: Meilisearch,
  id: string,
  body: BodyPartial,
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<void> {
  await awaitTaskOrThrow(
    "upsertMessageBody",
    client.index<MessageDoc>(indexUid).updateDocuments([{ id, ...body }]),
  );
}

/** Fetch a single document by id. Returns `null` when no document exists. */
export async function getMessageDoc(
  client: Meilisearch,
  id: string,
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<MessageDoc | null> {
  try {
    return await client.index<MessageDoc>(indexUid).getDocument(id);
  } catch (err) {
    if (err instanceof MeilisearchApiError && err.cause?.code === "document_not_found") {
      return null;
    }
    throw err;
  }
}

/** Returns the number of documents actually removed (0 or 1). Idempotent. */
export async function deleteMessageDoc(
  client: Meilisearch,
  id: string,
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<number> {
  const task = await awaitTaskOrThrow(
    "deleteMessageDoc",
    client.index<MessageDoc>(indexUid).deleteDocument(id),
  );
  return task.details?.deletedDocuments ?? 0;
}

/**
 * Delete every document for a given email account.
 * Returns the number of documents actually removed (0 when nothing matched).
 */
export async function deleteMessagesByEmailAccount(
  client: Meilisearch,
  emailAccountId: string,
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<number> {
  if (!/^[A-Za-z0-9_-]+$/.test(emailAccountId)) {
    throw new Error(`unsafe emailAccountId for filter expression: ${emailAccountId}`);
  }
  const task = await awaitTaskOrThrow(
    "deleteMessagesByEmailAccount",
    client
      .index<MessageDoc>(indexUid)
      // `emailAccountId` values are nanoid-shaped (URL-safe alphanumerics +
      // `_`/`-`), so embedding directly in the filter expression is safe;
      // the regex above rejects anything that would.
      .deleteDocuments({ filter: `emailAccountId = "${emailAccountId}"` }),
  );
  return task.details?.deletedDocuments ?? 0;
}
