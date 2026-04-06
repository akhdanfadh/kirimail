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

/**
 * A single mailbox address from an IMAP ENVELOPE.
 *
 * IMAP returns addresses as a 4-tuple `(name adl mailbox host)`. imapflow
 * combines mailbox+host into a single `address` string and drops the obsolete
 * `adl` (source route, RFC 2822 §4.4) which is NIL in all modern mail.
 *
 * @see https://www.rfc-editor.org/rfc/rfc3501#section-7.4.2 - ENVELOPE address structure
 * @see https://www.rfc-editor.org/rfc/rfc2822#section-3.4 - Address specification
 */
export interface MessageAddress {
  /** Display name (e.g., "John Doe"), RFC 2047-decoded by imapflow. Null if absent. */
  name: string | null;
  /**
   * Full email address (e.g., "john@example.com").
   * Null for RFC 2822 group syntax sentinel entries where host is NIL.
   */
  address: string | null;
}

/**
 * Parsed IMAP ENVELOPE structure.
 *
 * String fields are null when the header is absent (IMAP NIL). Address arrays
 * are empty when the header is absent or has no parseable addresses. imapflow
 * parses the raw ENVELOPE data before we see it.
 *
 * @see https://www.rfc-editor.org/rfc/rfc3501#section-7.4.2 - ENVELOPE fields
 * @see https://www.rfc-editor.org/rfc/rfc2822#section-3.6 - Header field definitions
 */
export interface MessageEnvelope {
  /** RFC 2822 Date header - origination date from the sender's perspective. */
  date: Date | null;
  /** RFC 2822 Subject header, RFC 2047-decoded by imapflow. */
  subject: string | null;
  /** Message author(s). RFC 2822 requires at least one, but real-world mail may violate this. */
  from: MessageAddress[];
  /**
   * Agent that submitted the message. Per RFC 3501 the server should default
   * this to `from` when absent, but imapflow passes through whatever the
   * server returns - empty if the server doesn't comply.
   */
  sender: MessageAddress[];
  /**
   * Where replies should be directed. Per RFC 3501 the server should default
   * this to `from` when absent, but imapflow passes through whatever the
   * server returns - empty if the server doesn't comply.
   */
  replyTo: MessageAddress[];
  /** Primary recipients. */
  to: MessageAddress[];
  /** Carbon-copy recipients. */
  cc: MessageAddress[];
  /** Blind carbon-copy recipients. Typically stripped before delivery, usually empty. */
  bcc: MessageAddress[];
  /**
   * In-Reply-To header - Message-ID(s) of the message being replied to.
   * Raw string as returned by IMAP; may contain multiple angle-bracketed IDs.
   */
  inReplyTo: string | null;
  /** Message-ID header - globally unique identifier. Format: `<local-part@domain>`. */
  messageId: string | null;
}

/** Message metadata fetched from IMAP FETCH (envelope + flags + size). */
export interface FetchedMessage {
  /**
   * IMAP UID - mailbox-scoped identifier that persists across sessions
   * (unlike sequence numbers). Not globally unique across mailboxes.
   */
  uid: number;
  /** Parsed IMAP ENVELOPE data. See {@link MessageEnvelope}. */
  envelope: MessageEnvelope;
  /**
   * RFC 2822 References header - full thread ancestry as a space-delimited
   * string of angle-bracketed Message-IDs. Fetched via
   * `BODY.PEEK[HEADER.FIELDS (REFERENCES)]` since IMAP ENVELOPE omits it.
   * Null if the header is absent.
   */
  references: string | null;
  /**
   * IMAP system and keyword flags for this message instance.
   * System flags: `\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`.
   * Servers may also return keyword flags (e.g., `$Forwarded`, `$Junk`).
   */
  flags: Set<string>;
  /**
   * Server-assigned receive timestamp (INTERNALDATE). Reflects when the
   * message arrived at the server, not the RFC 2822 Date header.
   */
  internalDate: Date;
  /** Full message size in octets as reported by RFC822.SIZE. Includes headers and body. */
  sizeOctets: number;
}

/** Options for `syncMailbox`. */
export interface MailboxSyncOptions {
  /** Date-based lookback: only fetch messages received since this date. Uses IMAP SEARCH SINCE. */
  since?: Date;
}

/**
 * Result of syncing a single mailbox. The adapter compares the stored cursor
 * against the current server state, fetches what's needed, and returns the
 * action taken alongside the fetched messages and new cursor.
 */
export interface MailboxSyncResult {
  /** What sync action was determined by cursor comparison. */
  action: SyncAction;
  /** Fetched message metadata, ordered newest-first (descending UID). */
  messages: FetchedMessage[];
  /** Current mailbox sync cursor to store for the next sync comparison. */
  cursor: SyncCursor;
}
