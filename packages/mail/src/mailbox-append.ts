import type { ImapFlow } from "imapflow";

import type { ImapConnectionCache, ImapCredentials } from "./connection";

import { appendMessage, ImapPrimitiveNonRetriableError } from "./commands";
import { assertMessageId } from "./threading";

/**
 * How far back to look when deduping.
 *
 * NOTE: IMAP SEARCH SINCE compares calendar dates (RFC 3501 #6.4.4), not
 * timestamps. The effective probe window is this value plus the remaining
 * hours of the current server day - up to ~48h. Safe direction: more
 * candidates fetched, never fewer. 1d headroom also absorbs typical
 * worker↔server clock drift.
 */
const DEDUP_SEARCH_WINDOW_MS = 24 * 60 * 60 * 1000;

const SENT_FLAGS = ["\\Seen"];

/**
 * Per account+mailbox+messageId serialization. Concurrent calls with the
 * same key chain off each other so only one probe+APPEND runs at a time,
 * eliminating the TOCTOU race within this process.
 *
 * NOTE: Cross-process serialization (multiple worker pods) still requires
 * pg-boss `singletonKey: messageId` at the job-enqueue level.
 */
const pending = new Map<string, Promise<AppendToMailboxResult>>();

export interface AppendToMailboxInput {
  imapCache: ImapConnectionCache;
  emailAccountId: string;
  imapCreds: ImapCredentials;
  /** Complete RFC 5322 message bytes. */
  raw: Buffer;
  /** Target mailbox path (e.g., "Sent", "Drafts"). */
  mailboxPath: string;
  /** IMAP flags to set on the appended message (e.g., `["\\Seen"]`, `["\\Draft"]`). */
  flags: string[];
  /**
   * Angle-bracketed Message-ID (RFC 5322 #3.6.4) that matches the
   * `Message-ID` header in `raw`. Used to probe the target mailbox before
   * each APPEND attempt so the job is safe to retry. Validated via
   * {@link assertMessageId}.
   *
   * NOTE: Must come from the same `buildRawMessage` result as `raw`.
   * Passing them from different calls causes the probe to dedup against the
   * wrong message.
   */
  messageId: string;
}

/**
 * Result of {@link appendToMailbox}.
 *
 * `deduped: true` - the message was already present; no APPEND was performed.
 * `uid` and `uidValidity` come from the FETCH envelope scan and are always
 * populated.
 *
 * `deduped: false` - APPEND was performed. `uid` and `uidValidity` are
 * populated when the server supports UIDPLUS (Gmail, Outlook, Stalwart);
 * null otherwise.
 */
export type AppendToMailboxResult =
  | { ok: true; deduped: true; uid: number; uidValidity: number }
  | { ok: true; deduped: false; uid: number; uidValidity: number }
  | { ok: true; deduped: false; uid: null; uidValidity: null };

/**
 * Input for {@link appendToSentFolder}. Same as {@link AppendToMailboxInput}
 * without `flags` - `\Seen` is applied automatically.
 */
export type AppendToSentFolderInput = Omit<AppendToMailboxInput, "flags">;

/**
 * APPEND raw MIME bytes to a mailbox via IMAP.
 *
 * Probes the mailbox for the Message-ID before each APPEND so this function
 * is idempotent - safe for pg-boss to retry on transient IMAP failures
 * without duplicating the copy. Concurrent calls for the same
 * account+mailbox+messageId within this process are serialized via the
 * {@link pending} chain. Throws on failure; callers decide retry vs
 * dead-letter based on the error type.
 *
 * NOTE: APPEND is unconditional here. Provider auto-copy awareness (Gmail,
 * Outlook) is gated upstream by callers consulting `smtp_identities.appendToSent`;
 * this primitive always performs the APPEND when invoked.
 */
export function appendToMailbox(input: AppendToMailboxInput): Promise<AppendToMailboxResult> {
  const { emailAccountId, mailboxPath, messageId } = input;

  try {
    assertMessageId(messageId);
  } catch (err) {
    // Wrap so a malformed messageId dead-letters instead of burning retries as a plain Error.
    return Promise.reject(new ImapPrimitiveNonRetriableError((err as Error).message));
  }

  // Canonicalize the key so the lane matches the probe's equality semantics.
  const key = `${emailAccountId}:${mailboxPath}:${canonicalMessageId(messageId)}`;
  const prev = pending.get(key) ?? Promise.resolve(null as unknown as AppendToMailboxResult);

  // Synchronous get->set: concurrent callers form a strict queue per key.
  const current: Promise<AppendToMailboxResult> = prev.then(
    () => runAppend(input),
    () => runAppend(input), // re-run even when predecessor threw
  );

  pending.set(key, current);
  // then(fn, fn) not finally(): finally() mirrors current's rejection into a
  // derived promise we'd discard unhandled.
  const cleanup = () => {
    if (pending.get(key) === current) pending.delete(key);
  };
  void current.then(cleanup, cleanup);

  return current;
}

/**
 * APPEND raw MIME bytes to the Sent mailbox. Wrapper around
 * {@link appendToMailbox} with Sent-specific flags (`\Seen`).
 *
 * Pass un-stripped raw MIME (BCC preserved) so the sender sees their
 * BCC recipients in Sent.
 */
export function appendToSentFolder(input: AppendToSentFolderInput): Promise<AppendToMailboxResult> {
  return appendToMailbox({ ...input, flags: SENT_FLAGS });
}

/** Execute the STATUS probe + optional APPEND for a single enqueued call. */
async function runAppend(input: AppendToMailboxInput): Promise<AppendToMailboxResult> {
  const { imapCache, emailAccountId, imapCreds, raw, mailboxPath, flags, messageId } = input;
  return imapCache.execute(emailAccountId, imapCreds, async (client) => {
    const found = await probeMessageId(client, mailboxPath, messageId);
    if (found) return { ok: true, deduped: true, uid: found.uid, uidValidity: found.uidValidity };
    const appended = await appendMessage(client, { mailbox: mailboxPath, raw, flags });
    if (appended.uid !== null && appended.uidValidity !== null) {
      return { ok: true, deduped: false, uid: appended.uid, uidValidity: appended.uidValidity };
    }
    return { ok: true, deduped: false, uid: null, uidValidity: null };
  });
}

/**
 * Returns `{ uid, uidValidity }` if any message in `mailbox` appended within
 * the last {@link DEDUP_SEARCH_WINDOW_MS} has the given Message-ID; `null`
 * otherwise. The returned uid lets callers skip a follow-up SEARCH.
 *
 * Uses SEARCH SINCE + FETCH ENVELOPE rather than SEARCH HEADER Message-ID:
 * some servers (e.g., Stalwart) back header-search with an async FTS index
 * that misses just-APPENDed messages. INTERNALDATE + ENVELOPE are
 * populated synchronously on APPEND and deterministic across servers.
 */
async function probeMessageId(
  client: ImapFlow,
  mailbox: string,
  messageId: string,
): Promise<{ uid: number; uidValidity: number } | null> {
  // STATUS before the lock: avoids a SELECT for empty mailboxes since STATUS
  // does not disturb the currently-selected mailbox. The common cold-start case
  // (new account, Sent is empty) returns here without a lock round-trip.
  const { messages } = await client.status(mailbox, { messages: true });
  if ((messages ?? 0) === 0) return null;

  // getMailboxLock serializes with other operations on the shared cached
  // connection (sync/IDLE/flag updates). Without it, our SELECT would race
  // their SELECT and corrupt client.mailbox state.
  const lock = await client.getMailboxLock(mailbox, {
    readOnly: true,
    description: `dedup probe: ${mailbox}`,
  });
  try {
    // Fail closed: silently skipping the probe would duplicate the copy.
    if (!client.mailbox) {
      throw new ImapPrimitiveNonRetriableError(
        "IMAP precondition violated: mailbox lock held but client.mailbox is unset",
      );
    }
    // Re-check after lock in case messages drained between status() and SELECT.
    if (client.mailbox.exists === 0) return null;
    const uidValidity = Number(client.mailbox.uidValidity);

    const since = new Date(Date.now() - DEDUP_SEARCH_WINDOW_MS);
    // TODO: Extract a searchMessages primitive to commands.ts when a second
    // caller needs search, so the false-return guard below is centralized
    // alongside the other IMAP primitives (storeFlags, moveMessages, etc.).
    const candidateUids = await client.search({ since }, { uid: true });
    // imapflow's search() returns false (Promise<number[] | false>) on session-state
    // failure despite the lock - non-retriable, dead-letter immediately.
    if (candidateUids === false) {
      throw new ImapPrimitiveNonRetriableError(
        "IMAP SEARCH returned false on a non-empty mailbox (probe failed)",
      );
    }
    if (candidateUids.length === 0) return null;

    const target = canonicalMessageId(messageId);
    for await (const msg of client.fetch(candidateUids, { envelope: true }, { uid: true })) {
      if (msg.envelope?.messageId && canonicalMessageId(msg.envelope.messageId) === target) {
        return { uid: msg.uid, uidValidity };
      }
    }
    return null;
  } finally {
    lock.release();
  }
}

/**
 * Normalize a Message-ID for equality comparison. Strips surrounding
 * angle brackets and lowercases the domain.
 *
 * - Brackets: stripped independently per side so a stray leading or trailing
 *   bracket doesn't prevent dedup (some middleware drops one side only).
 * - Local-part: case-preserved (RFC 5322 treats case as significant).
 * - Domain: case-folded (DNS is case-insensitive; Exchange rewrites case).
 *
 * Malformed server-side ids fall through to inequality - safe default is
 * append, not dedup.
 */
function canonicalMessageId(id: string): string {
  const unbracketed = id.replace(/^<|>$/g, "");
  const at = unbracketed.lastIndexOf("@");
  if (at < 0) return unbracketed;
  return unbracketed.slice(0, at + 1) + unbracketed.slice(at + 1).toLowerCase();
}
