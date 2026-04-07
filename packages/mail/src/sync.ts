import type { ImapFlow } from "imapflow";

import type {
  ImapCredentials,
  SyncMailboxInput,
  SyncMailboxesResult,
  SyncMailboxesOptions,
  SyncMailboxResult,
  SyncAction,
  SyncCursor,
} from "./types";

import { withImapConnection } from "./connection";
import { fetchMessages } from "./fetch";

/**
 * Compare a stored sync cursor against the current server cursor to determine
 * what sync action is needed.
 *
 * Uses balanced-math heuristic for deletion detection: if the increase in
 * uidNext equals the increase in messageCount, only additions happened.
 * A mismatch means deletions (or moves) also occurred, requiring full sync.
 *
 * @param stored - Previously stored cursor, or null if this is the first sync.
 * @param current - Current cursor from the IMAP server (via discovery), or null
 *   if STATUS response was incomplete (e.g. missing uidValidity/uidNext).
 *
 * @see https://github.com/postalsys/emailengine - balanced-math pattern reference
 * @see https://blog.nodemailer.com/2021/04/19/tracking-deleted-messages-on-an-imap-account/ - deletion detection approach
 */
export function compareSyncCursors(
  stored: SyncCursor | null,
  current: SyncCursor | null,
): SyncAction {
  if (stored === null || current === null) {
    return { type: "full-resync", reason: "no-prior-cursor" };
  }

  if (stored.uidValidity !== current.uidValidity) {
    return { type: "full-resync", reason: "uid-validity-changed" };
  }

  const uidNextDiff = current.uidNext - stored.uidNext;
  const messageCountDiff = current.messageCount - stored.messageCount;

  const newMessages = uidNextDiff > 0;

  const flagChanges =
    stored.highestModseq !== null &&
    current.highestModseq !== null &&
    current.highestModseq > stored.highestModseq;

  // If uidNext increased but the message count didn't grow by the same
  // amount, some messages were also deleted - partial sync is unsafe
  const additionsOnly = uidNextDiff === messageCountDiff;

  if (!newMessages && !flagChanges && additionsOnly) {
    return { type: "noop" };
  }

  return { type: "incremental", newMessages, flagChanges, additionsOnly };
}

/** Sync a single mailbox on an already-open connection (internal helper). */
async function syncMailboxOnConnection(
  client: ImapFlow,
  path: string,
  storedCursor: SyncCursor | null,
  options?: SyncMailboxesOptions,
): Promise<SyncMailboxResult> {
  const mailbox = await client.mailboxOpen(path);

  const currentCursor: SyncCursor = {
    uidValidity: Number(mailbox.uidValidity),
    uidNext: mailbox.uidNext,
    messageCount: mailbox.exists,
    highestModseq: mailbox.highestModseq != null ? Number(mailbox.highestModseq) : null,
  };

  const action = compareSyncCursors(storedCursor, currentCursor);

  if (action.type === "noop") {
    return { action, messages: [], cursor: currentCursor, remoteUids: null };
  }

  if (mailbox.exists === 0) {
    return { action, messages: [], cursor: currentCursor, remoteUids: [] };
  }

  if (action.type === "full-resync") {
    const messages = await fetchMessages(client, options?.since);
    return { action, messages, cursor: currentCursor, remoteUids: null };
  }

  // Incremental: fetch new messages if uidNext advanced
  const messages =
    action.newMessages && storedCursor
      ? await fetchMessages(client, undefined, storedCursor.uidNext)
      : [];

  // When deletions detected, enumerate current server UIDs for reconciliation
  const remoteUids = !action.additionsOnly
    ? // || (not ??) because imapflow search() returns false instead of
      // null/undefined when no mailbox is selected
      (await client.search({ all: true }, { uid: true })) || []
    : null;

  return { action, messages, cursor: currentCursor, remoteUids };
}

/**
 * Sync mailboxes for an account on a single IMAP connection. Opens one
 * connection and iterates mailboxes sequentially.
 *
 * If a mailbox fails (e.g., deleted on server since discovery), the error
 * is collected and iteration continues. A failed SELECT does not kill the
 * IMAP connection. If the connection itself drops, remaining mailboxes are skipped.
 *
 * @param creds - IMAP credentials for the account.
 * @param mailboxes - Mailboxes to sync with their stored cursors.
 * @param options - Optional archive depth lookback via `since`, applied to all mailboxes.
 */
export async function syncMailboxes(
  creds: ImapCredentials,
  mailboxes: SyncMailboxInput[],
  options?: SyncMailboxesOptions,
): Promise<SyncMailboxesResult> {
  return withImapConnection(creds, async (client) => {
    const results = new Map<string, SyncMailboxResult>();
    const errors = new Map<string, Error>();

    for (const { path, storedCursor } of mailboxes) {
      // Connection dropped (server timeout, network error) - no point
      // trying remaining mailboxes on a dead connection
      if (!client.usable) break;

      try {
        results.set(path, await syncMailboxOnConnection(client, path, storedCursor, options));
      } catch (error) {
        errors.set(path, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return { results, errors };
  });
}
