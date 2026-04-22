import type { DiscoveredMailbox, FetchedMessage, MailboxRole, SyncCursor } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, notInArray } from "drizzle-orm";

import type * as schema from "../schema";
import type { InsertDomainEventInput } from "./domain-event";

import { generateId } from "../id";
import { mailboxes, messages } from "../schema";
import { insertDomainEvents } from "./domain-event";

type Db = NodePgDatabase<typeof schema>;

/**
 * Find a mailbox path by role for an account.
 * Returns the path if a matching mailbox exists, `null` otherwise.
 */
export async function findMailboxPathByRole(
  db: Db,
  emailAccountId: string,
  role: MailboxRole,
): Promise<string | null> {
  const [row] = await db
    .select({ path: mailboxes.path })
    .from(mailboxes)
    .where(and(eq(mailboxes.emailAccountId, emailAccountId), eq(mailboxes.role, role)))
    .limit(1);
  return row?.path ?? null;
}

// ---------------------------------------------------------------------------
// applyMailboxSync
// ---------------------------------------------------------------------------

/** Counts returned by {@link applyMailboxSync}. */
export interface ApplyMailboxSyncResult {
  messagesCreated: number;
  messagesDeleted: number;
}

/**
 * Apply mailbox sync results in a single transaction: delete messages the
 * server removed, insert new messages, emit one `message.synced` event per
 * newly-inserted message, and update the mailbox cursor. A repeat sync of
 * already-stored messages emits nothing; deletes emit nothing either.
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
export async function applyMailboxSync(
  db: Db,
  mailboxId: string,
  fetchedMessages: FetchedMessage[],
  serverCursor: SyncCursor,
  remoteUids: number[] | null,
  oldUidValidity: number | null,
): Promise<ApplyMailboxSyncResult> {
  return db.transaction(async (tx) => {
    let messagesCreated = 0;
    let messagesDeleted = 0;

    // NOTE: delete paths below don't emit events. Search/index consumers
    // will show stale docs until the next reindex reconciles drift. Add
    // `message.deleted` and emit here if real-time delete consistency
    // becomes load-bearing.

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
        attachments: msg.attachments,
        internalDate: msg.internalDate,
        sizeOctets: msg.sizeOctets,
      }));

      // NOTE: onConflictDoNothing drops flag changes on already-stored rows
      // (e.g. a message newly marked \Seen). Unblock by switching to
      // onConflictDoUpdate on flags + a `message.flags-changed` event type,
      // once a consumer needs flag fidelity (search facets, rules engine).
      const inserted = await tx
        .insert(messages)
        .values(rows)
        .onConflictDoNothing({
          target: [messages.mailboxId, messages.providerUid, messages.uidValidity],
        })
        .returning({ id: messages.id });
      messagesCreated = inserted.length;

      // Payload omitted - schema default fills `{}`. `inserted` is empty on
      // re-syncs (onConflictDoNothing) and insertDomainEvents short-circuits.
      const events: InsertDomainEventInput[] = inserted.map((row) => ({
        aggregateType: "message",
        aggregateId: row.id,
        eventType: "message.synced",
      }));
      await insertDomainEvents(tx, events);
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

// ---------------------------------------------------------------------------
// reconcileMailboxes
// ---------------------------------------------------------------------------

/** Flattened mailbox with parent tracking, produced by {@link flattenMailboxTree}. */
interface FlatMailbox {
  path: string;
  delimiter: string | null;
  specialUse: string | null;
  role: MailboxRole;
  parentPath: string | null;
}

/** Flatten a recursive DiscoveredMailbox tree into ordered rows with parent tracking. */
function flattenMailboxTree(
  nodes: DiscoveredMailbox[],
  parentPath: string | null = null,
): FlatMailbox[] {
  const result: FlatMailbox[] = [];
  for (const node of nodes) {
    result.push({
      path: node.path,
      delimiter: node.delimiter,
      specialUse: node.specialUse,
      role: node.role,
      parentPath,
    });
    result.push(...flattenMailboxTree(node.children, node.path));
  }
  return result;
}

/**
 * Per-mailbox DB state returned by {@link reconcileMailboxes} so the
 * sync handler can build `SyncMailboxInput[]` without a second query.
 */
interface MailboxEntry {
  id: string;
  storedCursor: SyncCursor | null;
}

/** Counts returned by {@link reconcileMailboxes}. */
export interface ReconcileMailboxesResult {
  inserted: number;
  updated: number;
  removed: number;
  mailboxByPath: Map<string, MailboxEntry>;
}

/**
 * Reconcile DB mailboxes with the server's current state. Fetches existing
 * rows, diffs against the discovered tree, then batch-inserts new rows,
 * updates only changed rows, and deletes stale ones.
 *
 * Callers must ensure single-writer per account - concurrent calls for the
 * same emailAccountId can hit unique constraint violations. The sync-account
 * pg-boss queue enforces this via stately policy + singletonKey.
 *
 * Identity is keyed on path, so a server-side rename appears as a deletion
 * (CASCADE removes messages) plus a new insert. TODO: Detect renames via
 * UIDVALIDITY matching to preserve messages when the server keeps UIDs.
 *
 * @param db - Drizzle database instance.
 * @param emailAccountId - The email account that owns these mailboxes.
 * @param mailboxTree - Root-level discovered mailboxes, flattened internally.
 */
export async function reconcileMailboxes(
  db: Db,
  emailAccountId: string,
  mailboxTree: DiscoveredMailbox[],
): Promise<ReconcileMailboxesResult> {
  const discoveredMailboxes = flattenMailboxTree(mailboxTree);
  const discoveredPathSet = new Set(discoveredMailboxes.map((d) => d.path));

  return db.transaction(async (tx) => {
    // 1. Load stored mailboxes for this account
    const storedRows = await tx
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.emailAccountId, emailAccountId));
    const storedByPath = new Map(storedRows.map((r) => [r.path, r]));

    // 2. Diff: classify each discovered mailbox as new or changed
    const newMailboxes: FlatMailbox[] = [];
    const changedRows: { rowId: string; discovered: FlatMailbox }[] = [];

    for (const disc of discoveredMailboxes) {
      const stored = storedByPath.get(disc.path);
      if (!stored) {
        newMailboxes.push(disc);
      } else if (
        stored.delimiter !== disc.delimiter ||
        stored.specialUse !== disc.specialUse ||
        stored.role !== disc.role
      ) {
        changedRows.push({ rowId: stored.id, discovered: disc });
      }
    }

    // 3. Build result map - start with stored rows that are still present
    const mailboxByPath = new Map<string, MailboxEntry>();

    for (const stored of storedRows) {
      if (!discoveredPathSet.has(stored.path)) continue; // skip stale (deleted) mailboxes
      const storedCursor: SyncCursor | null =
        stored.uidValidity != null && stored.uidNext != null
          ? {
              uidValidity: stored.uidValidity,
              uidNext: stored.uidNext,
              messageCount: stored.messageCount ?? 0,
              highestModseq: stored.highestModseq ?? null,
            }
          : null;
      mailboxByPath.set(stored.path, { id: stored.id, storedCursor });
    }

    // 4. Batch insert new mailboxes
    if (newMailboxes.length > 0) {
      // parentId references are deferred (step 6) to avoid ordering and FK issues.
      // Cursor fields are intentionally omitted - they stay null so the sync
      // handler sees storedCursor = null and triggers a full initial resync.
      // applyMailboxSync owns cursor writes after each successful sync.
      const insertValues = newMailboxes.map((disc) => ({
        id: generateId(),
        emailAccountId,
        path: disc.path,
        delimiter: disc.delimiter,
        specialUse: disc.specialUse,
        role: disc.role,
      }));

      const insertedRows = await tx.insert(mailboxes).values(insertValues).returning({
        id: mailboxes.id,
        path: mailboxes.path,
      });

      for (const row of insertedRows) {
        mailboxByPath.set(row.path, { id: row.id, storedCursor: null });
      }
    }

    // 5. Update changed mailboxes (metadata only - cursor is applyMailboxSync's domain)
    for (const { rowId, discovered: disc } of changedRows) {
      await tx
        .update(mailboxes)
        .set({
          delimiter: disc.delimiter,
          specialUse: disc.specialUse,
          role: disc.role,
        })
        .where(eq(mailboxes.id, rowId));
    }

    // 6. Fix parentId references (only where needed)
    for (const disc of discoveredMailboxes) {
      const storedRow = storedByPath.get(disc.path);
      const selfEntry = mailboxByPath.get(disc.path)!;

      if (disc.parentPath == null) {
        // Clear parentId for mailboxes that moved to root, otherwise CASCADE
        // on the old parent's deletion would incorrectly delete this mailbox.
        if (storedRow?.parentId != null) {
          await tx.update(mailboxes).set({ parentId: null }).where(eq(mailboxes.id, selfEntry.id));
        }
        continue;
      }

      const parentEntry = mailboxByPath.get(disc.parentPath);
      if (!parentEntry) continue;
      if (storedRow?.parentId === parentEntry.id) continue;

      await tx
        .update(mailboxes)
        .set({ parentId: parentEntry.id })
        .where(eq(mailboxes.id, selfEntry.id));
    }

    // 7. Delete stale mailboxes (CASCADE deletes their messages)
    let removed = 0;
    const hasStale = storedRows.some((r) => !discoveredPathSet.has(r.path));
    if (hasStale) {
      const deletedRows = await tx
        .delete(mailboxes)
        .where(
          and(
            eq(mailboxes.emailAccountId, emailAccountId),
            notInArray(mailboxes.path, [...discoveredPathSet]),
          ),
        )
        .returning({ id: mailboxes.id });
      removed = deletedRows.length;
    }

    return {
      inserted: newMailboxes.length,
      updated: changedRows.length,
      removed,
      mailboxByPath,
    };
  });
}
