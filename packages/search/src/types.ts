import type { AttachmentMetadata } from "@kirimail/shared";

/**
 * Single Meilisearch document representing one synced message.
 *
 * Derived search projection of the `messages` row - RFC 5322 header names
 * (no `*Address` suffix), addresses as `"Name <addr>"` strings, dates as
 * unix seconds. Sync-only fields (`providerUid`, `uidValidity`) absent;
 * `sentDate` absent too (sender-controlled, unreliable) - `receivedDate`
 * is the canonical date for search.
 *
 * Optional fields are omitted (not nulled) when not yet known so
 * partial-update writes layer cleanly without overwriting prior fields.
 */
export interface MessageDoc {
  /** Same value as `messages.id` in DB; locked as the index primary key. */
  id: string;
  userId: string;
  emailAccountId: string;
  mailboxId: string;

  /** `null` when the IMAP envelope reported NIL. */
  subject: string | null;
  /**
   * Each entry is `"Name <addr>"`, or `"<addr>"` when name is NIL. RFC 5322
   * allows multiple authors but in practice there is exactly one entry;
   * empty array means the envelope reported no From header.
   */
  from: string[];
  /** Same form as {@link MessageDoc.from}. */
  to: string[];
  /** Same form as {@link MessageDoc.from}. */
  cc: string[];
  /** Same form as {@link MessageDoc.from}; usually empty after server-side delivery. */
  bcc: string[];

  /** IMAP INTERNALDATE as unix seconds - server-receive timestamp, monotonic. */
  receivedDate: number;
  /** RFC822.SIZE in bytes - full message size including headers and body. */
  sizeBytes: number;
  /** IMAP system and keyword flags (e.g. `\Seen`, `\Flagged`). */
  flags: string[];
  /**
   * True when the message body is end-to-end encrypted. When true,
   * `bodyText` and `bodyHtml` are never populated by the body-fetch stage.
   */
  encrypted: boolean;

  attachments?: AttachmentMetadata[];
  bodyText?: string;
  /** Raw HTML - sanitization happens at render time, not at index time. */
  bodyHtml?: string;
}
