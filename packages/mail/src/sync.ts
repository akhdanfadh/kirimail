import type {
  ImapCredentials,
  SyncMailboxOptions,
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

/**
 * Sync a single mailbox: connect, compare cursors, fetch new messages, and
 * enumerate server UIDs when deletions are detected. Disconnect when done.
 *
 * @param creds - IMAP credentials for the account.
 * @param path - Mailbox path to sync (e.g., "INBOX").
 * @param storedCursor - Previously stored cursor, or null for initial sync.
 * @param options - Optional archive depth lookback via `since`.
 */
export async function syncMailbox(
  creds: ImapCredentials,
  path: string,
  storedCursor: SyncCursor | null,
  options?: SyncMailboxOptions,
): Promise<SyncMailboxResult> {
  return withImapConnection(creds, async (client) => {
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
  });
}
