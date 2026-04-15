/** Category of an IMAP error, determining retry strategy. */
export type ImapErrorCategory =
  | "auth" // bad credentials
  | "transient" // network hiccup, worth retrying
  | "rate-limit" // provider throttling
  | "protocol"; // non-retryable server error, catch-all

/** Result of classifying an IMAP error. */
export interface ClassifiedError {
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
const TRANSIENT_CODES = new Set([
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
 * {@link ClassifiedError} indicating whether the caller should retry,
 * surface an auth problem, back off for rate-limiting, or give up.
 *
 * @see https://github.com/postalsys/imapflow/blob/master/lib/tools.js - AuthenticationFailure class
 * @see https://github.com/postalsys/emailengine/blob/master/lib/email-client/base-client.js - isTransientError
 */
export function classifyImapError(err: unknown): ClassifiedError {
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
  if (code && TRANSIENT_CODES.has(code)) {
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
