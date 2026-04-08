/** Normalized mailbox roles used across the app. */
export type MailboxRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "custom";

/**
 * Per-mailbox IMAP sync cursor for incremental sync.
 *
 * @see https://www.rfc-editor.org/rfc/rfc3501#section-2.3.1.1 - UID and UIDVALIDITY semantics
 * @see https://www.rfc-editor.org/rfc/rfc7162 - CONDSTORE/QRESYNC (HIGHESTMODSEQ)
 * @see https://www.rfc-editor.org/rfc/rfc4549 - Recommended disconnected IMAP sync algorithm
 */
export interface SyncCursor {
  /** If it changes, all cached UIDs for this mailbox are invalid. */
  uidValidity: number;
  /** Messages with UID >= this value are new since last sync. */
  uidNext: number;
  /** Total message count: a drop signals possible deletions. */
  messageCount: number;
  /** Flag-change detection. null if server lacks CONDSTORE. */
  highestModseq: number | null;
}

/**
 * A mailbox discovered via IMAP LIST with normalized role and hierarchy.
 *
 * @see https://www.rfc-editor.org/rfc/rfc3501#section-7.2.2 - LIST response format
 * @see https://www.rfc-editor.org/rfc/rfc6154 - Special-use mailbox attributes
 * @see https://www.rfc-editor.org/rfc/rfc5819 - LIST-STATUS (cursor capture in one round-trip)
 */
export interface DiscoveredMailbox {
  /** Full mailbox path as returned by the server. */
  path: string;
  /** Provider hierarchy separator. null if flat namespace. */
  delimiter: string | null;
  /** Raw special-use attribute. null if none advertised. */
  specialUse: string | null;
  /** Normalized app role derived from special-use attributes or name patterns. */
  role: MailboxRole;
  /** Sync cursor captured via LIST-STATUS. null if status was unavailable. */
  syncCursor: SyncCursor | null;
  /** Sub-mailboxes under this node, built from delimiter-split paths during discovery. */
  children: DiscoveredMailbox[];
}
