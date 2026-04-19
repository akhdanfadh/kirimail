/**
 * Outbound messages repository.
 *
 * Status lifecycle:
 *
 *  insert          markSending          markSent       delete
 *  ------> pending -----------> sending --------> sent ------> (gone)
 *           |  ^----------------|  |  ^
 *           |   resetToPending     |  |        retryFailed
 *           |  (transient error)   |  | (account-owner initiated)
 *           |                      |  \---------------------------> failed
 *           |                      \----------------------------------^  ^
 *           |                        markFailed (deterministic error)    |
 *           \-----------------------------------------------------------/
 *
 * Status lifecycle notes:
 * - Every transition is guarded and returns `undefined` when rejected.
 *   Callers treat this as "someone else got there first" and do not retry blindly.
 * - `attempts` bumps on each accepted `-> sending` transition.
 * - Mutations return the row without `rawMime` to avoid big payload every update.
 *
 * Other notes:
 * - `lastError` / `lastErrorCategory` describe current state, not history.
 * - `sent` is a transient marker: the last consumer calls `deleteOutboundMessage` on
 *   success. No rows with `status = 'sent'` should persist after their consumers finish.
 *   NOTE: This temporal invariant isn't expressible at the DB layer. Sustained `sent`
 *   rows (detectable via `sent_at` age) indicate the append worker silently exhausted
 *   retries; operational cleanup via a cron reaper is the right mitigation.
 * - NOTE: `sending` has a symmetric stuck-row risk (send-email crashes mid-SMTP, worker
 *   evicts the job without resetting status). Another reaper job could be added.
 */

import type { RetryableSmtpErrorCategory, SmtpErrorCategory } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, getColumns, inArray, lt, sql } from "drizzle-orm";

import type * as schema from "../schema";

import { generateId } from "../id";
import { outboundMessages } from "../schema";

type Db = NodePgDatabase<typeof schema>;

// Spread-based projection so new columns flow into `.returning()` sites without touching callers.
const { rawMime: _rawMime, ...outboundWithoutRawMime } = getColumns(outboundMessages);

/** Cap on stored `lastError` — enough for the head of a verbose SMTP response without bloating the row. */
const MAX_LAST_ERROR_LENGTH = 1024;
const TRUNCATION_SUFFIX = "...";

function truncateErrorMessage(msg: string): string {
  if (msg.length <= MAX_LAST_ERROR_LENGTH) return msg;
  return msg.slice(0, MAX_LAST_ERROR_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/** Input accepted by {@link insertOutboundMessage}. */
export interface InsertOutboundMessageInput {
  emailAccountId: string;
  /** Should belong to {@link emailAccountId}, enforced by DB. */
  smtpIdentityId: string;
  rawMime: Buffer;
  messageId: string;
  /** SMTP MAIL FROM address (bare, no display name / angle brackets). */
  envelopeFrom: string;
  /** SMTP RCPT TO list, including BCC. Must be non-empty. */
  envelopeTo: string[];
}

/** Insert a `pending` row with `attempts=0` (schema defaults). */
export async function insertOutboundMessage(db: Db, input: InsertOutboundMessageInput) {
  const [row] = await db
    .insert(outboundMessages)
    .values({ id: generateId(), ...input })
    .returning(outboundWithoutRawMime);
  return row;
}

/** Fetch by ID, including `rawMime` (workers need the bytes). */
export async function getOutboundMessageById(db: Db, id: string) {
  const [row] = await db.select().from(outboundMessages).where(eq(outboundMessages.id, id));
  return row;
}

/** Guarded `pending -> sending`. Bumps `attempts`. */
export async function markPendingOutboundMessageSending(db: Db, id: string) {
  const [row] = await db
    .update(outboundMessages)
    .set({
      status: "sending",
      attempts: sql`${outboundMessages.attempts} + 1`,
      lastError: null,
      lastErrorCategory: null,
    })
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.status, "pending")))
    .returning(outboundWithoutRawMime);
  return row;
}

/** Guarded `failed -> sending`. Bumps `attempts`. User/admin-initiated. */
export async function retryFailedOutboundMessage(db: Db, id: string) {
  const [row] = await db
    .update(outboundMessages)
    .set({
      status: "sending",
      attempts: sql`${outboundMessages.attempts} + 1`,
      lastError: null,
      lastErrorCategory: null,
    })
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.status, "failed")))
    .returning(outboundWithoutRawMime);
  return row;
}

/**
 * Guarded `sending -> pending`. Preserves the `(category, error)` stamp
 * on the row — in contrast with {@link markPendingOutboundMessageSending},
 * which clears it on the next attempt.
 */
export async function resetSendingOutboundMessageToPending(
  db: Db,
  id: string,
  category: RetryableSmtpErrorCategory,
  error: string,
) {
  const [row] = await db
    .update(outboundMessages)
    .set({
      status: "pending",
      lastError: truncateErrorMessage(error),
      lastErrorCategory: category,
    })
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.status, "sending")))
    .returning(outboundWithoutRawMime);
  return row;
}

/**
 * Guarded `sending -> sent`. Stamps `sentAt` and persists
 * `rejectedRecipients` (empty for full acceptance). The last consumer
 * should then call {@link deleteOutboundMessage}.
 */
export async function markSendingOutboundMessageSent(
  db: Db,
  id: string,
  rejectedRecipients: string[] = [],
) {
  const [row] = await db
    .update(outboundMessages)
    .set({
      status: "sent",
      sentAt: new Date(),
      lastError: null,
      lastErrorCategory: null,
      rejectedRecipients,
    })
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.status, "sending")))
    .returning(outboundWithoutRawMime);
  return row;
}

/**
 * Delete the row. Called by the last consumer on success.
 *
 * Not state-guarded: any of the state-guarded transitions already prevent
 * accidental deletion of an in-flight row (a worker wouldn't call this unless
 * `markSent` returned a row or the `appendToSent` path completed successfully).
 */
export async function deleteOutboundMessage(db: Db, id: string) {
  const [row] = await db
    .delete(outboundMessages)
    .where(eq(outboundMessages.id, id))
    .returning({ id: outboundMessages.id });
  return row;
}

/**
 * Bulk-delete `sent` rows whose `sentAt` predates `olderThan`.
 *
 * Only touches `status = 'sent'`: `failed` rows are terminal-for-humans
 * awaiting user-initiated retry and must never be swept here.
 */
export async function reapStaleSentOutboundMessages(db: Db, olderThan: Date) {
  return db
    .delete(outboundMessages)
    .where(and(eq(outboundMessages.status, "sent"), lt(outboundMessages.sentAt, olderThan)))
    .returning({
      id: outboundMessages.id,
      emailAccountId: outboundMessages.emailAccountId,
      messageId: outboundMessages.messageId,
      sentAt: outboundMessages.sentAt,
    });
}

/**
 * Guarded `pending | sending -> failed`. Rejects `sent` (resurrection)
 * and `failed` (would silently overwrite `lastError` with a potentially stale report).
 */
export async function markOutboundMessageFailed(
  db: Db,
  id: string,
  category: SmtpErrorCategory,
  error: string,
) {
  const [row] = await db
    .update(outboundMessages)
    .set({
      status: "failed",
      lastError: truncateErrorMessage(error),
      lastErrorCategory: category,
    })
    .where(
      and(eq(outboundMessages.id, id), inArray(outboundMessages.status, ["pending", "sending"])),
    )
    .returning(outboundWithoutRawMime);
  return row;
}
