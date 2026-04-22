import type { FetchedMessage, MessageAddress, SyncCursor } from "@kirimail/shared";
import type { ImapFlow, MessageAddressObject } from "imapflow";

import type { ImapCredentials } from "./connection";

import { withImapConnection } from "./connection";
import { parseAttachments } from "./parser";

// ---------------------------------------------------------------------------
// Types and interfaces
// ---------------------------------------------------------------------------

/** Action needed based on comparing stored vs current sync cursor. */
type SyncAction =
  | {
      type: "full-resync";
      /** Why a full resync is required instead of an incremental update. */
      reason: "no-prior-cursor" | "uid-validity-changed";
    }
  | {
      type: "incremental";
      /** True when current uidNext exceeds the stored cursor's uidNext. */
      newMessages: boolean;
      /** True when HIGHESTMODSEQ advanced (CONDSTORE). False if either modseq is null. */
      flagChanges: boolean;
      /** Balanced-math heuristic: true when uidNext delta equals messageCount delta (no deletions mixed in). */
      additionsOnly: boolean;
    }
  | { type: "noop" };

/** Per-mailbox input for {@link syncMailboxes}. */
export interface SyncMailboxInput {
  /** Full mailbox path as returned by the server (e.g., "INBOX", "Sent"). */
  path: string;
  /** Previously stored cursor for this mailbox, or null for initial sync. */
  storedCursor: SyncCursor | null;
}

/** Result for a single mailbox sync operation. */
export interface SyncMailboxResult {
  /** What sync action was determined by cursor comparison. */
  action: SyncAction;
  /** Fetched message metadata, ordered newest-first (descending UID). */
  messages: FetchedMessage[];
  /** Current mailbox sync cursor to store for the next sync comparison. */
  cursor: SyncCursor;
  /** Complete set of UIDs currently on the server for this mailbox. */
  remoteUids: number[] | null;
}

/** Options for {@link syncMailboxes}, applied to all mailboxes in the batch. */
export interface SyncMailboxesOptions {
  /** Date-based lookback: only fetch messages received since this date. Uses IMAP SEARCH SINCE. */
  since?: Date;
}

/** Result of syncing multiple mailboxes. */
export interface SyncMailboxesResult {
  /** Per-path results for successfully synced mailboxes. */
  results: Map<string, SyncMailboxResult>;
  /** Per-path errors for mailboxes that failed (e.g., deleted on server). */
  errors: Map<string, Error>;
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fetch logic
// ---------------------------------------------------------------------------

/**
 * Fetch message metadata from the currently-open mailbox.
 *
 * This is the IMAP-specific data acquisition layer. It handles UID range
 * resolution, ENVELOPE parsing, References header fetching, and address
 * mapping. Internal to the sync pipeline - called by `syncMailbox`.
 *
 * @param client - Connected ImapFlow client with a mailbox already open.
 * @param since - Date-based lookback filter (IMAP SEARCH SINCE).
 * @param uidSince - Only fetch UIDs >= this value (incremental sync).
 */
async function fetchMessages(
  client: ImapFlow,
  since?: Date,
  uidSince?: number,
): Promise<FetchedMessage[]> {
  if (!client.mailbox) {
    throw new Error("fetchMessages requires a mailbox to be open - call mailboxOpen first");
  }

  // Determine the UID range to fetch based on options
  let range: string;
  if (uidSince != null) {
    range = `${uidSince}:*`;
  } else if (since != null) {
    const uids = await client.search({ since }, { uid: true });
    if (!uids || uids.length === 0) return [];
    range = uids.join(",");
  } else {
    range = "1:*";
  }

  // Fetch messages in the specified UID range with required metadata
  const messages: FetchedMessage[] = [];
  for await (const msg of client.fetch(
    range,
    {
      uid: true,
      envelope: true,
      bodyStructure: true,
      flags: true,
      internalDate: true,
      size: true,
      headers: ["references"], // for threading
    },
    { uid: true },
  )) {
    messages.push({
      uid: msg.uid,
      envelope: {
        date: msg.envelope?.date instanceof Date ? msg.envelope.date : null,
        subject: msg.envelope?.subject ?? null,
        from: mapAddresses(msg.envelope?.from),
        sender: mapAddresses(msg.envelope?.sender),
        replyTo: mapAddresses(msg.envelope?.replyTo),
        to: mapAddresses(msg.envelope?.to),
        cc: mapAddresses(msg.envelope?.cc),
        bcc: mapAddresses(msg.envelope?.bcc),
        inReplyTo: msg.envelope?.inReplyTo ?? null,
        messageId: msg.envelope?.messageId ?? null,
      },
      references: parseHeaderValue(msg.headers, "references"),
      flags: msg.flags ?? new Set(),
      internalDate:
        msg.internalDate instanceof Date ? msg.internalDate : new Date(msg.internalDate as string),
      sizeOctets: msg.size ?? 0,
      attachments: parseAttachments(msg.bodyStructure),
    });
  }

  // Newest-first: higher UID = more recently received
  messages.sort((a, b) => b.uid - a.uid);
  return messages;
}

/** Convert imapflow addresses (undefined/empty fields) to our type (null fields). */
function mapAddresses(addrs: MessageAddressObject[] | undefined): MessageAddress[] {
  if (!addrs) return [];
  // Use || to coerce empty strings to null (imapflow returns "" for group syntax markers)
  return addrs.map((a) => ({ name: a.name || null, address: a.address || null }));
}

/**
 * Extract a single header value from a raw RFC 5322 header buffer.
 * Multi-line values (folded headers) are unfolded before returning.
 */
export function parseHeaderValue(buf: Buffer | undefined, name: string): string | null {
  if (!buf || buf.length === 0) return null;
  const text = buf.toString("utf-8");
  // Header name is case-insensitive; value may be folded across lines
  const re = new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t]+.+)*)`, "im");
  const match = re.exec(text);
  if (!match) return null;
  // Unfold: replace CRLF + whitespace with a single space
  return match[1]!.replace(/\r?\n[ \t]+/g, " ").trim();
}
