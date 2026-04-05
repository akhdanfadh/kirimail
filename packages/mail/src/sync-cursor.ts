import type { SyncAction, SyncCursor } from "./types";

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
