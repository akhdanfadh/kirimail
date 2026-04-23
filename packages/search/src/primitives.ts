import type { Meilisearch } from "meilisearch";

import { MeilisearchApiError } from "meilisearch";

import type { MessageDoc } from "./types";

import { MESSAGES_INDEX_UID } from "./config";
import { awaitTaskOrThrow } from "./tasks";

// NOTE: `upsertMessageBody` and `upsertMessageFlags` only write some of a doc's
// fields. If no doc with that id exists, Meilisearch creates one anyway, that is
// an "orphan" that's missing the tenant fields (userId / emailAccountId / mailboxId)
// and so won't show up in any user's search. How it happens: an async worker (body
// fetch, flag sync) acts on a message that the dispatcher deletes mid-way; the late
// partial write lands on a doc that's just been removed. Two-layer fix at that worker:
// (1) before the upsert, re-read the `messages` row and call `getMessageDoc`; skip
// if either is missing (shrinks the race window to milliseconds). (2) a scheduled
// cleanup job runs `deleteDocuments` filtered for missing tenant fields to clear any
// residual. Swept docs stay gone: no code writes tenant fields as a partial update,
// so an orphan can't come back to life.

/**
 * The non-body projection of {@link MessageDoc} written by the dispatcher
 * when a `message.synced` event fires. Headers and attachments metadata are
 * both known at sync time and written in a single Meilisearch task.
 *
 * `attachments` is required (not optional as in {@link MessageDoc}) so the
 * dispatcher must always pass the current set - including `[]` on reparse -
 * to replace any stale list left from a prior sync.
 */
export type SyncedMessageDoc = Omit<MessageDoc, "bodyText" | "bodyHtml" | "attachments"> & {
  attachments: NonNullable<MessageDoc["attachments"]>;
};

/** The body-field subset of {@link MessageDoc} written at the body-fetch stage. */
export type BodyPartial = Pick<MessageDoc, "bodyText" | "bodyHtml">;

/**
 * Sync-stage upsert: writes headers and attachments metadata in one Meilisearch
 * task. Partial-merge is done via `updateDocuments` so re-dispatches preserve
 * later-stage body fields written by the body-fetch worker.
 */
export async function upsertSyncedMessage(
  client: Meilisearch,
  doc: SyncedMessageDoc,
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<void> {
  await awaitTaskOrThrow(
    "upsertSyncedMessage",
    client.index<MessageDoc>(indexUid).updateDocuments([doc]),
  );
}

/**
 * Flag-sync stage partial upsert. Writes ONLY `flags`, so the full header doc
 * doesn't need to be rewritten when a CONDSTORE flag-delta fetch surfaces a
 * `\Seen` / `\Flagged` / keyword change.
 *
 * Caller invariant: the document must already exist (created via
 * {@link upsertSyncedMessage}). Calling this on a missing id creates an
 * orphan doc - invisible to tenant-scoped queries and unreachable by
 * {@link deleteMessagesByEmailAccount}.
 */
export async function upsertMessageFlags(
  client: Meilisearch,
  id: string,
  flags: string[],
  indexUid: string = MESSAGES_INDEX_UID,
): Promise<void> {
  await awaitTaskOrThrow(
    "upsertMessageFlags",
    client.index<MessageDoc>(indexUid).updateDocuments([{ id, flags }]),
  );
}

/**
 * Body-stage partial upsert.
 *
 * Caller invariant: the document must already exist (created via
 * {@link upsertSyncedMessage}). Calling this on a missing id creates an
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
