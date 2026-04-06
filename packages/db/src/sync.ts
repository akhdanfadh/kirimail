import type { FetchedMessage, SyncCursor } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";

import type * as schema from "./schema";

import { generateId } from "./id";
import { mailboxes, messages } from "./schema";

type Db = NodePgDatabase<typeof schema>;

/** Counts returned by {@link applySync}. */
export interface ApplySyncResult {
  messagesCreated: number;
}

// TODO: Add deletion reconciliation in this transaction when the sync
// orchestrator handles the `additionsOnly: false` signal. Will need
// the current server UID list to diff against stored rows.
/**
 * Apply sync results to the database: insert new messages, update the
 * mailbox cursor. Runs in one transaction so a failure rolls back both.
 */
export async function applySync(
  db: Db,
  mailboxId: string,
  fetchedMessages: FetchedMessage[],
  cursor: SyncCursor,
): Promise<ApplySyncResult> {
  return db.transaction(async (tx) => {
    let messagesCreated = 0;

    if (fetchedMessages.length > 0) {
      const rows: (typeof messages.$inferInsert)[] = fetchedMessages.map((msg) => ({
        id: generateId(),
        mailboxId,
        providerUid: msg.uid,
        uidValidity: cursor.uidValidity,
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

      await tx
        .insert(messages)
        .values(rows)
        .onConflictDoNothing({
          target: [messages.mailboxId, messages.providerUid, messages.uidValidity],
        });
      messagesCreated = rows.length;
    }

    // Always update mailbox cursor (even for empty syncs / noop)
    await tx
      .update(mailboxes)
      .set({
        uidValidity: cursor.uidValidity,
        uidNext: cursor.uidNext,
        messageCount: cursor.messageCount,
        highestModseq: cursor.highestModseq,
      })
      .where(eq(mailboxes.id, mailboxId));

    return { messagesCreated };
  });
}
