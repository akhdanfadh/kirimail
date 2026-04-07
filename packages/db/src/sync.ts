import type { FetchedMessage, SyncCursor } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, notInArray } from "drizzle-orm";

import type * as schema from "./schema";

import { generateId } from "./id";
import { mailboxes, messages } from "./schema";

type Db = NodePgDatabase<typeof schema>;

/** Counts returned by {@link applySync}. */
export interface ApplySyncResult {
  /** Rows inserted (excludes conflict-skipped duplicates). */
  messagesCreated: number;
  /** Rows removed by uidValidity purge and/or remoteUids reconciliation. */
  messagesDeleted: number;
}

/**
 * Apply sync results to the database: delete stale messages, insert new
 * messages, and update the mailbox cursor. Runs in one transaction so a
 * failure rolls back everything.
 *
 * @param db - Drizzle database instance.
 * @param mailboxId - ID of the mailbox row to sync into.
 * @param fetchedMessages - New messages fetched from the IMAP server.
 * @param serverCursor - Current sync cursor from the server, stored after the transaction.
 * @param remoteUids - Complete UID set currently on the server. When non-null,
 *   rows whose `providerUid` is NOT in this set (same mailboxId + uidValidity)
 *   are deleted. `null` means no deletion reconciliation needed.
 * @param oldUidValidity - Previous uidValidity from the stored cursor. When
 *   non-null and differs from `serverCursor.uidValidity`, all rows with this
 *   old value are deleted (mailbox was rebuilt on the server). `null` when
 *   there is no prior uidValidity to clean up.
 */
export async function applySync(
  db: Db,
  mailboxId: string,
  fetchedMessages: FetchedMessage[],
  serverCursor: SyncCursor,
  remoteUids: number[] | null,
  oldUidValidity: number | null,
): Promise<ApplySyncResult> {
  return db.transaction(async (tx) => {
    let messagesCreated = 0;
    let messagesDeleted = 0;

    // 1. UIDVALIDITY change: purge all rows with old uidValidity
    if (oldUidValidity != null && oldUidValidity !== serverCursor.uidValidity) {
      const deleted = await tx
        .delete(messages)
        .where(and(eq(messages.mailboxId, mailboxId), eq(messages.uidValidity, oldUidValidity)))
        .returning({ id: messages.id });
      messagesDeleted += deleted.length;
    }

    // 2. Incremental deletion: remove UIDs not in server's current set.
    if (remoteUids != null) {
      const deleted = await tx
        .delete(messages)
        .where(
          and(
            eq(messages.mailboxId, mailboxId),
            eq(messages.uidValidity, serverCursor.uidValidity),
            // Drizzle's notInArray(col, []) returns sql`true`, which correctly
            // deletes all rows for that mailbox+uidValidity (empty mailbox case).
            notInArray(messages.providerUid, remoteUids),
          ),
        )
        .returning({ id: messages.id });
      messagesDeleted += deleted.length;
    }

    // 3. Insert new messages
    if (fetchedMessages.length > 0) {
      const rows: (typeof messages.$inferInsert)[] = fetchedMessages.map((msg) => ({
        id: generateId(),
        mailboxId,
        providerUid: msg.uid,
        uidValidity: serverCursor.uidValidity,
        headerMessageId: msg.envelope.messageId,
        subject: msg.envelope.subject,
        inReplyTo: msg.envelope.inReplyTo,
        references: msg.references,
        sentDate: msg.envelope.date,
        fromAddress: msg.envelope.from,
        senderAddress: msg.envelope.sender,
        replyToAddress: msg.envelope.replyTo,
        toAddress: msg.envelope.to,
        ccAddress: msg.envelope.cc,
        bccAddress: msg.envelope.bcc,
        flags: [...msg.flags],
        internalDate: msg.internalDate,
        sizeOctets: msg.sizeOctets,
      }));

      const inserted = await tx
        .insert(messages)
        .values(rows)
        .onConflictDoNothing({
          target: [messages.mailboxId, messages.providerUid, messages.uidValidity],
        })
        .returning({ id: messages.id });
      messagesCreated = inserted.length;
    }

    // 4. Always update mailbox cursor (even for empty syncs / noop)
    await tx
      .update(mailboxes)
      .set({
        uidValidity: serverCursor.uidValidity,
        uidNext: serverCursor.uidNext,
        messageCount: serverCursor.messageCount,
        highestModseq: serverCursor.highestModseq,
      })
      .where(eq(mailboxes.id, mailboxId));

    return { messagesCreated, messagesDeleted };
  });
}
