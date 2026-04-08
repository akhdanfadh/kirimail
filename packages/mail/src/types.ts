import type { DiscoveredMailbox, FetchedMessage, SyncCursor } from "@kirimail/shared";

export type {
  DiscoveredMailbox,
  FetchedMessage,
  MailboxRole,
  MessageAddress,
  MessageEnvelope,
  SyncCursor,
} from "@kirimail/shared";

/** Action needed based on comparing stored vs current sync cursor. */
export type SyncAction =
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

/** Result of mailbox discovery for an IMAP account. */
export interface DiscoveryResult {
  /** Root-level mailboxes; descendants are nested via {@link DiscoveredMailbox.children}. */
  mailboxes: DiscoveredMailbox[];
}

/**
 * Credentials needed to connect to an IMAP server.
 *
 * @see https://www.rfc-editor.org/rfc/rfc3501#section-6.2.3 - LOGIN command
 * @see https://www.rfc-editor.org/rfc/rfc8314 - Use of TLS for email (port/security guidance)
 */
export interface ImapCredentials {
  /** IMAP server hostname (e.g. "imap.gmail.com"). */
  host: string;
  /** IMAP server port (e.g. 993 for TLS, 143 for STARTTLS). */
  port: number;
  /** Whether to use implicit TLS on connect (true for port 993). */
  secure: boolean;
  /** Login username, typically the full email address. */
  user: string;
  /** Login password or app-specific password. */
  pass: string;
}

/** AES-256-GCM encrypted credential envelope for DB storage. */
export interface CredentialEnvelope {
  /** Base64-encoded initialization vector. */
  iv: string;
  /** Base64-encoded encrypted payload. */
  ciphertext: string;
  /** Base64-encoded GCM authentication tag for tamper detection. */
  authTag: string;
  /** Encryption key version for rotation and re-encryption support. */
  keyVersion: number;
}

/** Per-mailbox input for `syncMailboxes`. */
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

/** Options for `syncMailboxes`, applied to all mailboxes in the batch. */
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
