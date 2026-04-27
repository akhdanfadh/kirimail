import type { ImapFlow } from "imapflow";

import { parseTextParts } from "./parser";

/** Input for {@link fetchMessageBody}. */
export interface FetchMessageBodyInput {
  /** Mailbox path containing the messsage (e.g., "INBOX"). */
  mailbox: string;
  /** Message UID to fetch. */
  uid: number;
  /**
   * Per-text-part byte ceiling forwarded to imapflow's `download(maxBytes)`.
   * Pass `Infinity` to opt out of the per-part cap.
   */
  maxBytesPerPart: number;
  /**
   * Cumulative ceiling across all text parts of one message.
   * Pass `Infinity` to opt out of the per-part cap.
   */
  maxBytesTotal: number;
}

/** Result for {@link fetchMessageBody}. */
export interface FetchMessageBodyResult {
  /**
   * Concatenated text/plain parts. Undefined when no eligible plain leaf was
   * extracted - parser found none, or {@link FetchMessageBodyInput.maxBytesTotal}
   * ran out before reaching one.
   */
  bodyText: string | undefined;
  /** Concatenated text/html parts. Same undefined conditions as {@link bodyText}. */
  bodyHtml: string | undefined;
  /**
   * True when the UID is not on the server (moved/expunged between sync and now).
   * Lets callers distinguish that race from "exists but has no indexable text"
   * (false, both body fields undefined).
   */
  uidNotFound: boolean;
}

/**
 * Pull the text/plain and text/html parts of one message and return them as decoded
 * UTF-8 strings. {@link parseTextParts} decides which BODYSTRUCTURE leaves count as
 * body; this function then issues one `download` per text part and relies on imapflow
 * to handle Content-Transfer-Encoding decoding and charset normalization to UTF-8.
 *
 * Safe to call concurrently against a shared `ImapFlow` connection - the mailbox is
 * opened with a lock, which serializes the SELECT + work + close cycle per connection.
 *
 * Byte caps in {@link FetchMessageBodyInput} are measured against decoded UTF-8 bytes.
 * This is approximation, not exact in that a few-byte overshoot is possible per part
 * when the cap lands mid-codepoint.
 *
 * Returns body fields as `undefined` (not empty string) when no eligible part was
 * extracted, so callers using partial-merge upserts don't write empty strings.
 *
 * @see https://imapflow.com/docs/guides/fetching-messages
 * @see https://imapflow.com/docs/api/imapflow-client/#downloadrange-part-options
 */
export async function fetchMessageBody(
  client: ImapFlow,
  input: FetchMessageBodyInput,
): Promise<FetchMessageBodyResult> {
  const uid = String(input.uid);
  const { maxBytesPerPart } = input;
  let bytesRemaining = input.maxBytesTotal;

  const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
  try {
    const msg = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
    // imapflow returns the literal `false` when no message matches the UID.
    // The truthiness check is the only API-stable miss test. Don't tighten it.
    if (!msg) return { bodyText: undefined, bodyHtml: undefined, uidNotFound: true };

    const textParts = parseTextParts(msg.bodyStructure);
    if (textParts.length === 0) {
      return { bodyText: undefined, bodyHtml: undefined, uidNotFound: false };
    }

    const plainChunks: string[] = [];
    const htmlChunks: string[] = [];
    for (const part of textParts) {
      // Prevents a multipart with many text leaves exploring worker RAM.
      if (bytesRemaining <= 0) break;

      const partCap = Math.min(maxBytesPerPart, bytesRemaining);
      const { content } = await client.download(uid, part.partPath, {
        uid: true,
        maxBytes: partCap,
      });
      // download() returns content-less when the message was expunged server-side between
      // our outer fetchOne anda this per-part fetch. The lock serialized our own operations
      // but doesn't stop other IMAP clients on the same account from expunging concurrently.
      if (!content) continue;

      const text = await collectStreamUtf8(content);
      // imapflow truncates at the requested byte count without checking UTF-8 character
      // boundaries (e.g., 😀 is 4 so a cut mid-chars leaves invalid trailing bytes).
      // Buffer.toString("utf8") replaces those with 3 bytes U+FFFD, so the decoded string's
      // byteLength can measure 1-2 bytes more than partCap. Harmless at any realistic budget.
      bytesRemaining -= Buffer.byteLength(text, "utf8");
      if (part.type === "plain") plainChunks.push(text);
      else htmlChunks.push(text);
    }

    return {
      // Multiple text/plain or text/html parts (rare; mailing-list digests,
      // some auto-generated reports under multipart/mixed) get joined with
      // a single newline. Matches EmailEngine's getText() behavior.
      bodyText: plainChunks.length > 0 ? plainChunks.join("\n") : undefined,
      bodyHtml: htmlChunks.length > 0 ? htmlChunks.join("\n") : undefined,
      uidNotFound: false,
    };
  } finally {
    lock.release();
  }
}

/** Collect every chunk from a stream and return them joined as a UTF-8 string. */
async function collectStreamUtf8(content: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  // imapflow's download() emits body bytes in chunks and converts the source to
  // UTF-8 internally for non-UTF-8 emails. So `toString("utf8")` on the joined
  // buffer is enough as we don't need to detect or convert charsets ourselves.
  // @see https://github.com/postalsys/imapflow/blob/master/lib/imap-flow.js
  return Buffer.concat(chunks).toString("utf8");
}
