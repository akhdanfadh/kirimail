import type { FetchedMessage, MailboxRole, SyncCursor } from "@kirimail/shared";

export type {
  FetchedMessage,
  MailboxRole,
  MessageAddress,
  MessageEnvelope,
  SyncCursor,
} from "@kirimail/shared";

/** Action needed based on comparing stored vs current sync cursor. */
export type SyncAction =
  | { type: "full-resync"; reason: "no-prior-cursor" | "uid-validity-changed" }
  | { type: "incremental"; newMessages: boolean; flagChanges: boolean; additionsOnly: boolean }
  | { type: "noop" };

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
  /** Sync cursor captured via LIST-STATUS. null if status was unavailable. */
  syncCursor: SyncCursor | null;
  /** Normalized app role derived from special-use attributes or name patterns. */
  role: MailboxRole;
  children: DiscoveredMailbox[];
}

/** Result of mailbox discovery for an IMAP account. */
export interface DiscoveryResult {
  mailboxes: DiscoveredMailbox[];
}

/**
 * Credentials needed to connect to an IMAP server.
 *
 * @see https://www.rfc-editor.org/rfc/rfc3501#section-6.2.3 - LOGIN command
 * @see https://www.rfc-editor.org/rfc/rfc8314 - Use of TLS for email (port/security guidance)
 */
export interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** AES-256-GCM encrypted credential envelope for DB storage. */
export interface CredentialEnvelope {
  iv: string;
  ciphertext: string;
  authTag: string;
  keyVersion: number;
}

/** Options for `syncMailbox`. */
export interface SyncMailboxOptions {
  /** Date-based lookback: only fetch messages received since this date. Uses IMAP SEARCH SINCE. */
  since?: Date;
}

/** Result for a mailbox sync operation. */
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
