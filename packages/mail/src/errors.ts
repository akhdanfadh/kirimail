// ---------------------------------------------------------------------------
// IMAP error classification
// ---------------------------------------------------------------------------

/** Category of an IMAP error, determining retry strategy. */
export type ImapErrorCategory =
  | "auth" // bad credentials
  | "transient" // network hiccup, worth retrying
  | "rate-limit" // provider throttling
  | "protocol"; // non-retryable server error, catch-all

/** Result of classifying an IMAP error. */
export interface ClassifiedImapError {
  category: ImapErrorCategory;
  message: string;
  /** Node.js or IMAP error code when available (e.g., "ETIMEDOUT"). */
  code?: string;
}

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

/**
 * Classify an IMAP error into a retry category. Mainly adjusted for imapflow.
 *
 * Accepts any value (including `null` for a clean close) and returns a
 * {@link ClassifiedImapError} indicating whether the caller should retry,
 * surface an auth problem, back off for rate-limiting, or give up.
 *
 * @see https://github.com/postalsys/imapflow/blob/master/lib/tools.js - AuthenticationFailure class
 * @see https://github.com/postalsys/emailengine/blob/master/lib/email-client/base-client.js - isTransientError
 */
export function classifyImapError(err: unknown): ClassifiedImapError {
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

// ---------------------------------------------------------------------------
// SMTP error classification
// ---------------------------------------------------------------------------

/** Category of an SMTP error, determining retry strategy. */
export type SmtpErrorCategory =
  | "auth" // bad credentials (EAUTH, ENOAUTH, EOAUTH2, 535)
  | "transient" // network hiccup, worth retrying
  | "rate-limit" // provider throttling (421)
  | "recipient" // invalid address (EENVELOPE, 550, 553)
  | "protocol"; // non-retryable server error (ETLS, EPROTOCOL, other 5xx)

/** Result of classifying an SMTP error. */
export interface ClassifiedSmtpError {
  category: SmtpErrorCategory;
  message: string;
  /** Nodemailer string code when available (e.g., "EAUTH", "ETIMEDOUT"). */
  code?: string;
  /** SMTP numeric response code when available (e.g., 550, 421). */
  responseCode?: number;
}

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
export function classifySmtpError(err: unknown): ClassifiedSmtpError {
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
  return { category: "transient", message, code, responseCode };
}
