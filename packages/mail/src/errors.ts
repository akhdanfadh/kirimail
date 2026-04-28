import type { ImapErrorCategory, SmtpErrorCategory } from "@kirimail/shared";

import { ImapNonRetriableError } from "./commands";

// ---------------------------------------------------------------------------
// IMAP error classification
// ---------------------------------------------------------------------------

/**
 * Error codes that indicate a transient failure worth retrying.
 *
 * Includes both Node.js socket errors and imapflow-specific codes.
 * imapflow sets its own error codes for connection-phase timeouts and
 * unexpected closes - these are distinct from Node.js socket codes.
 *
 * @see https://nodejs.org/api/errors.html#common-system-errors
 * @see https://github.com/postalsys/imapflow/blob/master/lib/imap-flow.js
 */
const IMAP_TRANSIENT_CODES = new Set([
  // Node.js socket errors
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  // imapflow-specific codes
  "ETIMEOUT", // socket inactivity timeout (imapflow's own, distinct from ETIMEDOUT)
  "NoConnection", // connection unavailable
  "EConnectionClosed", // write to closed socket
  "CONNECT_TIMEOUT", // TCP connection timeout (default 90s)
  "GREETING_TIMEOUT", // server didn't send greeting (default 16s)
  "UPGRADE_TIMEOUT", // STARTTLS took too long (default 10s)
  "ClosedAfterConnectTLS", // unexpected close after TLS connect
  "ClosedAfterConnectText", // unexpected close after plaintext connect
]);

/** Result of {@link classifyImapError}. */
export interface ClassifyImapErrorResult {
  category: ImapErrorCategory;
  message: string;
  /** Node.js or IMAP error code when available (e.g., "ETIMEDOUT"). */
  code?: string;
}

/**
 * Classify an IMAP error into a retry category. Mainly adjusted for imapflow.
 *
 * Accepts any value (including `null` for a clean close) and returns a
 * {@link ClassifyImapErrorResult} indicating whether the caller should retry,
 * surface an auth problem, back off for rate-limiting, or give up.
 *
 * @see https://github.com/postalsys/imapflow/blob/master/lib/tools.js - AuthenticationFailure class
 * @see https://github.com/postalsys/emailengine/blob/master/lib/email-client/base-client.js - isTransientError
 */
export function classifyImapError(err: unknown): ClassifyImapErrorResult {
  if (err == null) {
    // imapflow's close event always fires with no argument - errors arrive
    // via a separate 'error' event. A null err means the connection closed
    // without a preceding error: server BYE, graceful shutdown, or imapflow
    // silently swallowing safe socket errors (ECONNRESET, EPIPE, etc.).
    // All of these are exactly when reconnection should happen.
    return { category: "transient", message: "connection closed" };
  }
  if (typeof err !== "object") {
    // JavaScript allows throwing primitives (strings, numbers), and we don't
    // control what imapflow internals or future callers pass. We can't inspect
    // .code or .authenticationFailed on a primitive, so we can't determine if
    // it's retryable - surface it rather than retry something we don't understand.
    return { category: "protocol", message: String(err) };
  }

  // imapflow errors are plain Error objects with .message and .code set manually,
  // but neither is guaranteed on an arbitrary object, so we check before using.
  const e = err as Record<string, unknown>;
  const message = typeof e.message === "string" ? e.message : String(err);
  const code = typeof e.code === "string" ? e.code : undefined;

  // Classification order matters - auth is checked first because imapflow sets
  // authenticationFailed = true on the error object, which is the most reliable
  // signal. Transient codes come from Node.js socket errors. Rate-limit is
  // provider-specific. Everything else falls through to protocol.

  // 1. Auth - imapflow sets this on login/authenticate failures
  if (e.authenticationFailed === true) {
    return { category: "auth", message, code };
  }

  // 2. Transient - Node.js socket-level network errors
  if (code && IMAP_TRANSIENT_CODES.has(code)) {
    return { category: "transient", message, code };
  }

  // 3. Rate-limit - imapflow throttle or provider "too many connections"
  // NOTE: imapflow sets err.throttleReset (ms) on ETHROTTLE from MS365's
  // "Suggested Backoff Time" response, and waits internally before re-raising.
  // We currently use a fixed 3x multiplier instead of this hint. If provider
  // throttle behavior needs tuning, read throttleReset from the error here.
  if (code === "ETHROTTLE" || /too many connections/i.test(message)) {
    return { category: "rate-limit", message, code };
  }

  // 4. Protocol - catch-all for non-retryable server errors
  return { category: "protocol", message, code };
}

/**
 * Translate a thrown error into a typed {@link ImapNonRetriableError} when
 * it matches a deterministic IMAP shape; otherwise return `undefined`.
 *
 * Callers wrap the whole connect+execute call site (`imapCache.execute`
 * directly, or helpers like `appendToSentFolder` that delegate to it) with
 * `throw asNonRetriableImapError(err, ctx) ?? err` so connect-time auth
 * failures and command-time NO/BAD flow through one classification site,
 * and unmatched errors bubble for normal retry.
 *
 * Wraps and returns only on positive evidence:
 * 1. Auth failure - imapflow sets `authenticationFailed === true` on
 *    LOGIN/AUTHENTICATE rejection (account-wide).
 * 2. NO on SELECT/EXAMINE/STATUS - mailbox doesn't exist (or access revoked).
 *    STATUS covers callers that probe a mailbox before acquiring the lock.
 *    Excludes RFC 5530 [INUSE] (another session holds the lock; transient).
 * 3. NO with `serverResponseCode` [NONEXISTENT] (RFC 5530) or [TRYCREATE]
 *    (RFC 3501 on APPEND/COPY) - verb-agnostic, picks up APPEND/COPY/MOVE
 *    that the verb list above misses.
 * 4. BAD on FETCH - protocol error on UID FETCH (the command imapflow's
 *    `download(uid, partPath)` issues internally).
 *
 * Anything else - including connection-level errors with no `responseStatus`
 * (ECONNRESET, ETIMEOUT, NoConnection, server BYE) - returns `undefined`.
 * The inverse posture (require positive evidence) means unknown shapes
 * never silently lose retries.
 *
 * `contextMessage` is prepended to the original message so ops output names
 * the failing operation. The original error is preserved on `cause`, so
 * imapflow's `responseStatus`, `executedCommand`, `serverResponseCode`, and
 * stack survive into `console.error` (util.inspect walks `.cause`).
 *
 * Already-typed {@link ImapNonRetriableError} throws from `@kirimail/mail`
 * primitives (e.g. storeFlags swallowed-falsy, appendToMailbox malformed
 * Message-ID) carry no imapflow fields - they fall through to `undefined`
 * here. The caller's `?? err` rethrows the original typed error unchanged
 * for the outer `instanceof ImapNonRetriableError` arm. Don't "fix" this
 * by special-casing `instanceof ImapNonRetriableError` here - it would add
 * a typed-on-typed wrap and bury the original stack one level deeper.
 *
 * Distinct from {@link classifyImapError}, which buckets errors into broad
 * retry categories for connection-lifecycle decisions (reconnect, give up
 * IDLE) and whose `"protocol"` bucket is a catch-all.
 *
 * NOTE: A discard here is permanent for the affected operation. Callers without an
 * alternate recovery path must rely on the user re-triggering the action after fixing
 * the underlying issue (e.g., credential rotation). Acceptable because the alternative
 * (3 retries x ~30/60/120s backoff per operation) burns hundreds of hours on a
 * rotated-credentials account. Revisit if production logs show transient NO/BAD shapes
 * that self-resolve - extend the [INUSE] bail list.
 *
 * NOTE: Credential-leakage audit. Logging `cause` to ops output is safe today because
 * imapflow masks the LOGIN password with `sensitive: true` (lib/commands/login.js) and
 * the compiler honors that via `isLogging: true` when building `executedCommand`
 * (lib/imap-flow.js); AUTHENTICATE challenge/response bytes are masked the same way.
 * Re-verify on imapflow major bump - grep `sensitive: true` in lib/commands/login.js,
 * confirm the compiler still uses `isLogging` for `executedCommand`. If either changes,
 * drop `cause` from console.error and log only `cause.responseStatus` / `cause.serverResponseCode`.
 *
 * NOTE: N queued jobs on a rotated-credentials account each open TCP+TLS+LOGIN
 * before getting discarded - much better than 3xN before, but a busy account
 * can still trip provider rate-limit or lockout heuristics (Gmail/M365 are touchy).
 * Fix is a per-account negative cache keyed on `authenticationFailed === true`
 * that short-circuits without a connect. Revisit when production logs show provider
 * throttling on rotated-cred accounts, or when lockout reports surface.
 *
 * @see https://github.com/postalsys/imapflow/blob/master/lib/imap-flow.js - search for `responseStatus`
 * @see https://datatracker.ietf.org/doc/html/rfc5530 - [INUSE], [NONEXISTENT]
 * @see https://datatracker.ietf.org/doc/html/rfc3501#section-7.1 - [TRYCREATE]
 */
export function asNonRetriableImapError(
  err: unknown,
  contextMessage: string,
): ImapNonRetriableError | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;

  // Trust the upstream contract: imapflow throws Error subclasses (the
  // non-object guard above already filters null/primitive). If a future
  // imapflow version starts throwing non-Error values, the symptom is
  // "ctx: undefined" in the message - recoverable, add a fallback then.
  const wrap = () =>
    new ImapNonRetriableError(`${contextMessage}: ${(err as Error).message}`, { cause: err });

  // 1. Auth failure - imapflow flags login/authenticate failures explicitly.
  if (e.authenticationFailed === true) return wrap();

  // 2,3,4. Server-issued NO/BAD - require `responseStatus` so connection-
  //        level errors (no responseStatus, no executedCommand) fall through.
  const status = typeof e.responseStatus === "string" ? e.responseStatus : undefined;
  if (status !== "NO" && status !== "BAD") return undefined;

  // imapflow compiles `executedCommand` as `<tag> [UID ]<VERB> <args>`.
  // Parse the VERB token rather than substring-matching the whole string,
  // so a quoted mailbox argument can't trigger a false positive.
  const cmd = typeof e.executedCommand === "string" ? e.executedCommand : "";
  const verb = /^\S+\s+(?:UID\s+)?(\S+)/.exec(cmd)?.[1]?.toUpperCase();

  // imapflow's enhanceCommandError extracts the bracket code (e.g. [INUSE],
  // [NONEXISTENT], [TRYCREATE]) from the tagged response into `serverResponseCode`.
  const code =
    typeof e.serverResponseCode === "string" ? e.serverResponseCode.toUpperCase() : undefined;

  if (status === "NO") {
    // [INUSE] - another session holds an exclusive lock. Transient: retrying
    // may succeed once the holder releases. Mostly self-hosted IMAP (Stalwart,
    // Dovecot exclusive locks); rare on hosted Gmail/M365. Bail before any
    // verb-based discard so SELECT-on-locked-mailbox stays retriable.
    if (code === "INUSE") return undefined;

    // Verb-agnostic positive signal: server explicitly said the mailbox
    // doesn't exist. Catches paths the verb list below misses, like
    // APPEND-with-TRYCREATE (Sent folder gone) or COPY/MOVE-with-NONEXISTENT
    // (destination gone).
    if (code === "NONEXISTENT" || code === "TRYCREATE") return wrap();

    // Verb-based fallback for servers that don't emit the bracket code.
    // STATUS covers probe-then-lock callers (mailbox-append.ts:164).
    if (verb === "SELECT" || verb === "EXAMINE" || verb === "STATUS") return wrap();
  }

  // BAD on FETCH (covers plain FETCH and UID FETCH).
  if (status === "BAD" && verb === "FETCH") return wrap();

  return undefined;
}

// ---------------------------------------------------------------------------
// SMTP error classification
// ---------------------------------------------------------------------------

/** Nodemailer error codes that indicate an authentication failure. */
const SMTP_AUTH_CODES = new Set([
  "EAUTH", // authentication failed
  "ENOAUTH", // no supported auth mechanisms
  "EOAUTH2", // OAuth2 token generation/refresh failed
]);

/**
 * Error codes that indicate a transient SMTP failure worth retrying.
 *
 * Includes Node.js socket errors and nodemailer-specific codes for
 * connection-phase failures.
 */
const SMTP_TRANSIENT_CODES = new Set([
  // Node.js socket errors
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  // nodemailer-specific codes
  // NOTE: ESOCKET covers certificate validation failures on direct TLS
  // connections (self-signed, expired). These won't self-heal on retry, but
  // the transient-by-default philosophy is the right trade-off - the retry
  // layer will exhaust attempts and surface the error to the user.
  "ESOCKET", // generic socket error (certificate failures, etc.)
  "ECONNECTION", // TCP connection setup failed
  "EDNS", // DNS resolution failed
  "EPROXY", // proxy connection failed (network-like, worth retrying)
  "EMAXLIMIT", // pool hit maxMessages limit, needs connection recycle
]);

/** Nodemailer error codes that indicate a non-retryable protocol/config error. */
const SMTP_PROTOCOL_CODES = new Set([
  "ETLS", // TLS handshake or STARTTLS failed
  "EPROTOCOL", // invalid SMTP server response
  "EMESSAGE", // message delivery error (content issue)
  "EREQUIRETLS", // REQUIRETLS not supported by server (RFC 8689)
  "ESTREAM", // stream processing error (message content issue)
  "ECONFIG", // invalid configuration - won't self-heal
]);

/** Result of {@link classifySmtpError}. */
export interface ClassifySmtpErrorResult {
  category: SmtpErrorCategory;
  message: string;
  /** Nodemailer string code when available (e.g., "EAUTH", "ETIMEDOUT"). */
  code?: string;
  /** SMTP numeric response code when available (e.g., 550, 421). */
  responseCode?: number;
}

/**
 * Classify an SMTP error into a retry category. Adjusted for nodemailer.
 *
 * Checks both `err.code` (nodemailer string) and `err.responseCode`
 * (SMTP numeric). Unknown errors default to "transient" because a lost
 * email is worse than an extra retry attempt.
 *
 * @see https://github.com/nodemailer/nodemailer/blob/master/lib/errors.js - error code definitions
 * @see https://en.wikipedia.org/wiki/List_of_SMTP_server_return_codes - SMTP reply code reference
 * @see https://github.com/postalsys/emailengine/blob/master/workers/submit.js - retry strategy reference
 */
export function classifySmtpError(err: unknown): ClassifySmtpErrorResult {
  if (err == null) {
    return { category: "transient", message: "unknown SMTP error (null)" };
  }
  if (typeof err !== "object") {
    // Can't inspect .code or .responseCode on a primitive. Default to
    // transient - retrying is safer than dropping an email.
    return { category: "transient", message: String(err) };
  }

  const e = err as Record<string, unknown>;
  const message = typeof e.message === "string" ? e.message : String(err);
  const code = typeof e.code === "string" ? e.code : undefined;
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : undefined;

  // Classification order matters - auth is most reliable (nodemailer sets
  // specific error codes), then recipient (SMTP response codes that must
  // not fall through to protocol), then rate-limit, then transient, then
  // protocol, then transient fallback.

  // 1. Auth - nodemailer string codes or SMTP auth response codes
  // 535: "Authentication credentials invalid"
  // 534: "Authentication mechanism is too weak" - user/admin must address
  if (code && SMTP_AUTH_CODES.has(code)) {
    return { category: "auth", message, code, responseCode };
  }
  if (responseCode === 534 || responseCode === 535) {
    return { category: "auth", message, code, responseCode };
  }

  // 2. Recipient - envelope/address errors (must precede 5xx protocol check)
  // 550: "Mailbox unavailable" (not found, no access, rejected)
  // 551: "User not local" (try alternate forward path)
  // 553: "Mailbox name not permitted"
  // 556: "Domain does not accept mail"
  if (code === "EENVELOPE") {
    return { category: "recipient", message, code, responseCode };
  }
  if (
    responseCode === 550 ||
    responseCode === 551 ||
    responseCode === 553 ||
    responseCode === 556
  ) {
    return { category: "recipient", message, code, responseCode };
  }

  // 3. Rate-limit - 421 "service unavailable" / "too many connections"
  // 421 is the standard SMTP rate-limit signal. Other 4xx codes with
  // throttle-like semantics (e.g., 452 "insufficient storage") land in
  // transient, which still retries - correct behavior for those cases.
  if (responseCode === 421) {
    return { category: "rate-limit", message, code, responseCode };
  }

  // 4. Transient - network/socket errors, remaining 4xx, 503
  // NOTE: 503 is technically 5xx (permanent) per RFC 5321, but "bad sequence
  // of commands" often results from connection state corruption or race
  // conditions in the SMTP dialog. Retrying with a fresh connection usually
  // succeeds. EmailEngine also retries 503.
  if (code && SMTP_TRANSIENT_CODES.has(code)) {
    return { category: "transient", message, code, responseCode };
  }
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) {
    return { category: "transient", message, code, responseCode };
  }
  if (responseCode === 503) {
    return { category: "transient", message, code, responseCode };
  }

  // 5. Protocol - non-retryable error codes and remaining 5xx
  // In practice, most 5xx errors already have a nodemailer code caught
  // earlier (EAUTH for auth failures, EENVELOPE for address rejections).
  // This catch-all handles bare 5xx responses without a recognized code.
  if (code && SMTP_PROTOCOL_CODES.has(code)) {
    return { category: "protocol", message, code, responseCode };
  }
  if (responseCode !== undefined && responseCode >= 500) {
    return { category: "protocol", message, code, responseCode };
  }

  // 6. Unknown -> transient (a lost email is worse than an extra retry)
  //
  // NOTE: if nodemailer's error shape drifts (field renames, new codes),
  // error objects we'd otherwise classify precisely fall through to here
  // and silently burn the caller's retry budget. Consider a DEBUG log on
  // this branch once telemetry is wired, so fall-through becomes visible.
  return { category: "transient", message, code, responseCode };
}
