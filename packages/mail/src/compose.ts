// oxlint-disable-next-line typescript-eslint/triple-slash-reference -- ambient declaration for untyped @zone-eu/mailsplit
/// <reference path="../types/mailsplit.d.ts" />

import type { MessageAddress } from "@kirimail/shared";
import type { SplitterChunk } from "@zone-eu/mailsplit";
import type Mail from "nodemailer/lib/mailer";

import { Joiner, Splitter } from "@zone-eu/mailsplit";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import MailComposer from "nodemailer/lib/mail-composer";

// oxlint-disable-next-line no-unused-vars -- imported for @link in JSDoc
import type { buildForwardHeaders, buildReplyHeaders } from "./threading";

/** Structured input for {@link buildRawMessage}. */
export interface BuildRawMessageOptions {
  /** Sender address. Must have a non-null `address` field. */
  from: MessageAddress;
  /**
   * The actual transmitter when it differs from `from` (e.g., a delegate
   * sending on behalf of someone). Populates the RFC 5322 Sender header.
   */
  sender?: MessageAddress;
  /** Primary recipients. Entries with null `address` are silently filtered. */
  to?: MessageAddress[];
  /** Carbon-copy recipients. */
  cc?: MessageAddress[];
  /** Blind carbon-copy recipients. Preserved in raw output (`keepBcc`) for SMTP envelope use. */
  bcc?: MessageAddress[];
  /**
   * Override where replies are directed. When set, recipients who hit Reply
   * address their message here instead of to the From address.
   */
  replyTo?: MessageAddress;
  /** RFC 5322 Subject header. */
  subject?: string;
  /** Plain text body. When both `text` and `html` are provided, produces multipart/alternative. */
  text?: string;
  /** HTML body. */
  html?: string;
  /**
   * File attachments. File path and URL content sources are blocked at
   * runtime - pass `content` as a string or Buffer instead.
   *
   * NOTE: No size or count limits are enforced here. Add limits at the
   * API boundary based on deployment constraints and provider limits.
   */
  attachments?: Mail.Attachment[];
  /** The Message-ID of the message being replied to. Produced by {@link buildReplyHeaders}. */
  inReplyTo?: string;
  /** Space-separated Message-ID chain. Produced by {@link buildReplyHeaders} / {@link buildForwardHeaders}. */
  references?: string;
  /** Custom Date header. Defaults to current UTC time when omitted. */
  date?: Date;
  /**
   * Additional headers passed directly to MailComposer.
   *
   * Use for extension headers (e.g., `{ "X-Mailer": "Kirimail" }`) or
   * standard headers without a dedicated field (e.g., `Message-Id`).
   * Headers with a dedicated field and MIME-structural headers
   * (Content-Type, MIME-Version, etc.) are rejected.
   */
  headers?: Record<string, string>;
  // NOTE: icalEvent deferred - iCalendar event for meeting invitations.
  // MailComposer accepts it as { method: string; content: string }.
  // Real use case for calendar workflows; higher priority than watchHtml/amp.
  // icalEvent?: { method?: string; content: string };
  // NOTE: watchHtml deferred - Apple Watch-specific HTML body. MailComposer
  // accepts it as a first-class field. Niche; revisit if needed.
  // watchHtml?: string;
  // NOTE: amp deferred - AMP4EMAIL interactive content. Must be a complete
  // valid AMP document. Gmail-specific; revisit if needed.
  // amp?: string;
  // NOTE: alternatives deferred - additional content versions beyond text/html
  // in multipart/alternative (e.g., AMP). Revisit alongside amp support.
  // alternatives?: Mail.Attachment[];
}

/** Output of {@link buildRawMessage}. */
export interface BuildRawMessageResult {
  /** Complete RFC 5322 message as raw bytes. Used for both SMTP send and IMAP APPEND. */
  raw: Buffer;
  /** Generated Message-ID header value (angle-bracketed, e.g., `<uuid@domain>`). */
  messageId: string;
  /** SMTP envelope derived from the message headers. */
  envelope: {
    /** Sender address from the From header. */
    from: string;
    /** All recipient addresses (to + cc + bcc). */
    to: string[];
  };
}

/**
 * Build a complete RFC 5322 message as raw MIME bytes.
 *
 * Wraps nodemailer's MailComposer. The same raw Buffer is used for both SMTP
 * send and IMAP APPEND to Sent folder - build once, never rebuild.
 *
 * @see https://nodemailer.com/extras/mailcomposer
 */
export async function buildRawMessage(
  options: BuildRawMessageOptions,
): Promise<BuildRawMessageResult> {
  const from = toNodemailerAddress(options.from, "from");
  const sender = options.sender ? toNodemailerAddress(options.sender, "sender") : undefined;
  const to = toNodemailerAddresses(options.to);
  const cc = toNodemailerAddresses(options.cc);
  const bcc = toNodemailerAddresses(options.bcc);
  const replyTo = options.replyTo ? toNodemailerAddress(options.replyTo, "replyTo") : undefined;

  if (to.length + cc.length + bcc.length === 0) {
    throw new Error("At least one recipient with a valid address is required");
  }

  if (options.headers) {
    assertNoBlockedHeaders(options.headers);
  }

  const compiled = new MailComposer({
    from,
    sender,
    to,
    cc,
    bcc,
    replyTo,
    subject: options.subject,
    date: options.date,
    text: options.text,
    html: options.html,
    attachments: options.attachments,
    inReplyTo: options.inReplyTo,
    references: options.references,
    headers: options.headers,
    // Content is always passed as strings/Buffers - never let MailComposer
    // perform file reads or network fetches as a side effect.
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();

  // Preserve BCC in the raw output - callers decide when to strip it
  // (stripBcc for SMTP transmission, keep as-is for Sent folder APPEND).
  compiled.keepBcc = true;

  // Generates ID on first call; build() reuses it.
  const messageId = compiled.messageId();
  const raw = await compiled.build();
  const envelope = compiled.getEnvelope();

  if (!envelope.from) {
    throw new Error("MailComposer produced no sender in envelope despite valid from address");
  }

  return {
    raw,
    messageId,
    envelope: { from: envelope.from, to: envelope.to },
  };
}

/**
 * Remove the BCC header from raw MIME bytes.
 *
 * Used before SMTP transmission - recipients must not see BCC addresses.
 * The Sent folder APPEND keeps BCC so the sender can see who they BCC'd.
 *
 * Uses `stream.promises.pipeline` to pipe raw bytes through mailsplit's
 * Splitter -> a header rewriter -> Joiner. pipeline handles error propagation
 * and stream cleanup (destroys all streams if any one fails).
 *
 * @see https://github.com/zone-eu/mailsplit/blob/master/lib/message-splitter.js - Splitter stream
 * @see https://github.com/zone-eu/mailsplit/blob/master/lib/message-joiner.js - Joiner stream
 * @see https://github.com/postalsys/emailengine/blob/master/lib/get-raw-email.js - EmailEngine's removeBcc
 */
export async function stripBcc(raw: Buffer): Promise<Buffer> {
  const splitter = new Splitter();
  const rewriter = createBccRewriter();
  const joiner = new Joiner();

  const chunks: Buffer[] = [];
  let length = 0;
  joiner.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    length += chunk.length;
  });

  await pipeline(Readable.from([raw]), splitter, rewriter, joiner);
  return Buffer.concat(chunks, length);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Headers blocked from the custom `headers` field. Two categories:
 * 1. Headers with dedicated fields on BuildRawMessageOptions -
 *    MailComposer overrides custom headers for these via setHeader, so
 *    passing them in `headers` would be silently ignored.
 * 2. MIME-structural headers auto-managed by MailComposer -
 *    overriding these produces duplicate headers that corrupt the message.
 *
 * Headers NOT blocked (e.g., Message-Id) can be passed through `headers`
 * when the caller needs explicit control.
 */
const BLOCKED_HEADERS = new Set([
  // Dedicated fields on BuildRawMessageOptions
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "in-reply-to",
  "references",
  // MIME-structural headers auto-managed by MailComposer
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "mime-version",
]);

/** Reject custom headers that collide with dedicated fields or MIME structure. */
function assertNoBlockedHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (BLOCKED_HEADERS.has(key.toLowerCase())) {
      throw new Error(
        `Header "${key}" must not be passed in custom headers - it is either a dedicated field or auto-managed by MailComposer`,
      );
    }
  }
}

/** Filter null-address entries and map to nodemailer's address format. */
function toNodemailerAddresses(addresses?: MessageAddress[]): Mail.Address[] {
  if (!addresses) return [];
  return addresses
    .filter((a): a is MessageAddress & { address: string } => a.address !== null)
    .map((a) => ({ name: a.name ?? "", address: a.address }));
}

/** Convert a single MessageAddress to nodemailer's address format. Throws if address is null. */
function toNodemailerAddress(address: MessageAddress, field: string): Mail.Address {
  if (!address.address) {
    throw new Error(`${field} address is required`);
  }
  return { name: address.name ?? "", address: address.address };
}

/**
 * Transform stream that removes the BCC header from the root MIME node.
 *
 * Follows the same pattern as EmailEngine's HeadersRewriter but with a
 * synchronous callback since we only need headers.remove().
 *
 * @see https://github.com/postalsys/emailengine/blob/master/lib/headers-rewriter.js
 */
function createBccRewriter(): Transform {
  return new Transform({
    readableObjectMode: true,
    writableObjectMode: true,
    transform(obj: SplitterChunk, _encoding, callback) {
      if (obj.type === "node" && obj.root) {
        obj.headers.remove("bcc");
      }
      this.push(obj);
      callback();
    },
  });
}
