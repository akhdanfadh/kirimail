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
  /**
   * Decoded text/plain content; multi-leaf messages joined with '\n'.
   * Undefined when the message had no text/plain part.
   */
  bodyText?: string;
  /**
   * Decoded text/html content; joined on the same terms as {@link bodyText}.
   * Stored unsanitized - sanitization happens at render time. Undefined
   * when the message had no text/html part.
   */
  bodyHtml?: string;
  /**
   * Search-only plain-text projection of {@link bodyHtml}. Defined only when
   * the message was HTML-only ({@link bodyText} undefined and {@link bodyHtml}
   * defined); otherwise absent, so {@link bodyText} and {@link bodyHtml} always
   * match the message's actual MIME shape.
   *
   * Excluded from `displayedAttributes`, so search responses and `_formatted`
   * snippets never expose it. CAVEAT: `displayedAttributes` does NOT apply to
   * `getDocument(id)` - doc-fetch consumers see this field and must ignore it
   * when rendering the message. Verified against Meilisearch v1.42.1; the
   * server's own OpenAPI docstring contradicts the implementation here, so
   * a future release that aligns them will fail integration tests noisily
   * and `getMessageDoc` will need an explicit `fields` projection.
   */
  bodyTextDerived?: string;
}
