import type { ImapFlow } from "imapflow";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Backoff computation
// ---------------------------------------------------------------------------

/** Configuration for exponential backoff with jitter. */
export interface BackoffConfig {
  /** Initial delay in milliseconds. */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (before jitter). */
  maxDelayMs: number;
  /** Multiplier applied per attempt. */
  multiplier: number;
  /** Maximum random jitter added to the delay in milliseconds. */
  jitterMs: number;
}

const DEFAULT_BACKOFF: BackoffConfig = {
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  multiplier: 1.5,
  jitterMs: 1_000,
};

/**
 * Compute the backoff delay for a reconnection attempt.
 *
 * Formula: `min(maxDelay, base * multiplier^min(attempt, 10)) + random(0, jitter)`
 *
 * Exponent is capped at 10 to prevent floating-point overflow.
 */
export function computeBackoffDelay(attempt: number, config?: Partial<BackoffConfig>): number {
  const { baseDelayMs, maxDelayMs, multiplier, jitterMs } = {
    ...DEFAULT_BACKOFF,
    ...config,
  };
  const cappedAttempt = Math.min(attempt, 10); // same approach as EmailEngine's `getNextDelay()`
  const exponentialDelay = baseDelayMs * Math.pow(multiplier, cappedAttempt);
  const clampedDelay = Math.min(maxDelayMs, exponentialDelay);
  const jitter = Math.random() * jitterMs;
  return clampedDelay + jitter;
}

// ---------------------------------------------------------------------------
// Reconnection manager
// ---------------------------------------------------------------------------

/** Options for creating a {@link ReconnectionManager}. */
export interface ReconnectionManagerOptions {
  /** Factory that creates and connects a new ImapFlow client. */
  connect: () => Promise<ImapFlow>;
  /**
   * Called after a successful reconnection with the new client.
   * The caller must take ownership of the client - the manager does not
   * store it.
   */
  onReconnected: (client: ImapFlow) => Promise<void>;
  /** Called immediately on every auth failure (surface to UI). */
  onAuthFailure?: (error: ClassifiedError) => void;
  /**
   * Called when auth failures persist beyond {@link authDisableThresholdMs}.
   * The caller should disable sync and surface a re-authentication prompt.
   */
  onAuthDisabled?: (error: ClassifiedError) => void;
  /** Called on non-retryable protocol errors. No reconnection is attempted. */
  onProtocolError?: (error: ClassifiedError) => void;
  /**
   * Called once when transient failures persist beyond
   * {@link prolongedOutageThresholdMs}. The caller should update the
   * account health state data model (e.g., mark as "degraded") so the
   * UI can surface the outage. Retries continue at a slower ceiling.
   *
   * NOTE: The account health state data model does not exist yet.
   * When implemented, it should be a per-account field in the database
   * (e.g., "connected" | "reconnecting" | "degraded" | "auth-failed" |
   * "disabled") that the UI reads to render connection status.
   */
  onProlongedOutage?: (error: ClassifiedError) => void;
  /** Override default backoff parameters. */
  backoff?: Partial<BackoffConfig>;
  /** Multiplier applied to baseDelayMs for rate-limit errors. Default: 5. */
  rateLimitBaseMultiplier?: number;
  /** Maximum delay (ms) for rate-limit errors. Default: 2 min. */
  rateLimitMaxDelayMs?: number;
  /** Duration (ms) of persistent auth failure before disabling sync. Default: 3 days. */
  authDisableThresholdMs?: number;
  /**
   * Maximum delay (ms) for auth failure retries. Default: 10 min.
   * Auth failures rarely self-resolve (user must fix credentials), so a higher
   * ceiling than transient errors avoids excessive failed attempts over the
   * 3-day circuit breaker window.
   */
  authMaxDelayMs?: number;
  /** Duration (ms) of continuous transient failure before firing {@link onProlongedOutage} and slowing retries. Default: 1 hour. */
  prolongedOutageThresholdMs?: number;
  /** Maximum delay (ms) after prolonged outage threshold is crossed. Default: 5 min. */
  prolongedOutageMaxDelayMs?: number;
}

const DEFAULT_AUTH_MAX_DELAY_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_RATE_LIMIT_BASE_MULTIPLIER = 5;
const DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 2 * 60 * 1000; // 2 min
const DEFAULT_AUTH_DISABLE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DEFAULT_PROLONGED_OUTAGE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_PROLONGED_OUTAGE_MAX_DELAY_MS = 5 * 60 * 1000; // 5 min

/**
 * Manages IMAP reconnection with error classification, exponential backoff,
 * and an auth failure circuit breaker.
 *
 * Inspired by EmailEngine's `reconnection-manager.js` + `base-client.js`.
 *
 * @example
 * ```ts
 * const manager = new ReconnectionManager({
 *   connect: async () => {
 *     const client = createImapClient(creds);
 *     await client.connect();
 *     return client;
 *   },
 *   onReconnected: async (client) => {
 *     // Check cursor, fetch missed messages, resume IDLE
 *   },
 *   onAuthFailure: (error) => {
 *     // Mark account as needing reauthentication in UI
 *   },
 * });
 * // When the IDLE connection drops:
 * imapClient.on("close", () => manager.handleDisconnect(lastError));
 * ```
 *
 * @see https://github.com/postalsys/emailengine/blob/master/lib/reconnection-manager.js
 * @see https://github.com/postalsys/emailengine/blob/master/lib/email-client/base-client.js
 */
export class ReconnectionManager {
  private readonly connect: () => Promise<ImapFlow>;
  private readonly onReconnected: (client: ImapFlow) => Promise<void>;
  private readonly onAuthFailure: ((error: ClassifiedError) => void) | undefined;
  private readonly onAuthDisabled: ((error: ClassifiedError) => void) | undefined;
  private readonly onProtocolError: ((error: ClassifiedError) => void) | undefined;
  private readonly onProlongedOutage: ((error: ClassifiedError) => void) | undefined;
  private readonly backoffConfig: BackoffConfig;
  private readonly rateLimitBaseMultiplier: number;
  private readonly rateLimitMaxDelayMs: number;
  private readonly authDisableThresholdMs: number;
  private readonly authMaxDelayMs: number;
  private readonly prolongedOutageThresholdMs: number;
  private readonly prolongedOutageMaxDelayMs: number;

  /** Consecutive failed reconnection attempts; escalates backoff, reset to 0 on success. */
  private attempts = 0;
  /** Timestamp (ms) of the first auth failure in the current window; starts the 3-day circuit breaker. */
  private firstAuthFailureAt: number | null = null;
  /** Timestamp (ms) of the first transient/rate-limit failure; starts the prolonged outage clock. */
  private firstTransientFailureAt: number | null = null;
  /** Whether onProlongedOutage has already fired for the current outage window. */
  private hasProlongedOutageNotified = false;
  /** Handle for the pending reconnect setTimeout, null when no retry is scheduled. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hard kill switch - set by stop(), prevents all further reconnection. */
  private isStopped = false;
  /** True while connect() is in-flight; prevents duplicate scheduling. */
  private isReconnecting = false;
  /** Incremented on reset() to invalidate in-flight attemptReconnect calls. */
  private resetVersion = 0;

  constructor(options: ReconnectionManagerOptions) {
    this.connect = options.connect;
    this.onReconnected = options.onReconnected;
    this.onAuthFailure = options.onAuthFailure;
    this.onAuthDisabled = options.onAuthDisabled;
    this.onProtocolError = options.onProtocolError;
    this.onProlongedOutage = options.onProlongedOutage;
    this.backoffConfig = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.rateLimitBaseMultiplier =
      options.rateLimitBaseMultiplier ?? DEFAULT_RATE_LIMIT_BASE_MULTIPLIER;
    this.rateLimitMaxDelayMs = options.rateLimitMaxDelayMs ?? DEFAULT_RATE_LIMIT_MAX_DELAY_MS;
    this.authDisableThresholdMs =
      options.authDisableThresholdMs ?? DEFAULT_AUTH_DISABLE_THRESHOLD_MS;
    this.authMaxDelayMs = options.authMaxDelayMs ?? DEFAULT_AUTH_MAX_DELAY_MS;
    this.prolongedOutageThresholdMs =
      options.prolongedOutageThresholdMs ?? DEFAULT_PROLONGED_OUTAGE_THRESHOLD_MS;
    this.prolongedOutageMaxDelayMs =
      options.prolongedOutageMaxDelayMs ?? DEFAULT_PROLONGED_OUTAGE_MAX_DELAY_MS;
  }

  /**
   * Handle an unexpected disconnect or connection error.
   *
   * Classifies the error and takes the appropriate action:
   * - transient / rate-limit: schedule reconnect with exponential backoff.
   * - auth: surface immediately via `onAuthFailure`, schedule reconnect
   *   (user might fix credentials), disable sync after threshold.
   * - protocol: surface via `onProtocolError`, no retry.
   */
  handleDisconnect(err: unknown): void {
    if (this.isStopped) return;

    // Debounce: skip if a reconnection is already scheduled or in-flight.
    // The reconnecting flag covers the async gap between timer fire and
    // connect() resolution, where reconnectTimer is null but an attempt
    // is still active.
    if (this.reconnectTimer !== null || this.isReconnecting) return;

    const classified = classifyImapError(err);

    // Notification callbacks are wrapped in try/catch so a broken callback
    // doesn't crash the manager.
    switch (classified.category) {
      case "protocol":
        // NOTE: Protocol errors get zero retries - revisit if providers
        // return NO for temporary conditions (some may do for rate limiting
        // or temporary mailbox unavailability).
        try {
          this.onProtocolError?.(classified);
        } catch (err) {
          // NOTE: Replace with structured logging when available.
          console.warn("onProtocolError callback threw", err);
        }
        return;

      case "auth":
        try {
          this.onAuthFailure?.(classified);
        } catch (err) {
          // NOTE: Replace with structured logging when available.
          console.warn("onAuthFailure callback threw", err);
        }
        if (this.firstAuthFailureAt === null) {
          this.firstAuthFailureAt = Date.now();
        }
        if (Date.now() - this.firstAuthFailureAt >= this.authDisableThresholdMs) {
          try {
            this.onAuthDisabled?.(classified);
          } catch (err) {
            // NOTE: Replace with structured logging when available.
            console.warn("onAuthDisabled callback threw", err);
          }
          this.stop();
          return;
        }
        this.scheduleReconnect(classified);
        return;

      case "rate-limit":
        // Auth tracking is NOT cleared here - a rate-limit failure says
        // nothing about whether credentials are valid. Only a successful
        // reconnect clears the auth window (in attemptReconnect).
        this.scheduleReconnect(classified);
        return;

      case "transient":
        // Auth tracking is NOT cleared here - a transient connect failure
        // says nothing about whether credentials are valid (TCP never
        // completed). Only a successful reconnect clears the auth window
        // (in attemptReconnect after connect + onReconnected succeed).
        if (this.firstTransientFailureAt === null) {
          this.firstTransientFailureAt = Date.now();
        }
        // After the prolonged outage threshold, notify once so the caller
        // can update the account health state data model (e.g., mark as
        // "degraded"). Retries continue but scheduleReconnect uses a
        // slower ceiling (prolongedOutageMaxDelayMs) once this fires.
        if (
          !this.hasProlongedOutageNotified &&
          Date.now() - this.firstTransientFailureAt >= this.prolongedOutageThresholdMs
        ) {
          this.hasProlongedOutageNotified = true;
          try {
            this.onProlongedOutage?.(classified);
          } catch (err) {
            // NOTE: Replace with structured logging when available.
            console.warn("onProlongedOutage callback threw", err);
          }
        }
        this.scheduleReconnect(classified);
        return;
    }
  }

  /** Cancel any pending reconnection. Idempotent. */
  stop(): void {
    this.isStopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Cancel any in-flight reconnection, clear all state, and re-enable the
   * manager. Safe to call in any state (stopped, reconnecting, or idle).
   *
   * Use when the manager should start fresh (e.g., user manually
   * reconnects an account). Does not trigger any reconnection - the next
   * {@link handleDisconnect} call will start a new cycle from attempt 0.
   */
  reset(): void {
    this.stop();
    this.resetVersion++;
    this.attempts = 0;
    this.firstAuthFailureAt = null;
    this.firstTransientFailureAt = null;
    this.hasProlongedOutageNotified = false;
    this.isStopped = false;
    this.isReconnecting = false;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Compute backoff delay (with higher base and cap for rate-limit) and set
   * a timer that fires {@link attemptReconnect}. Increments {@link attempts}
   * so the next call backs off further.
   */
  private scheduleReconnect(classified: ClassifiedError): void {
    let config: BackoffConfig;

    if (classified.category === "rate-limit") {
      config = {
        ...this.backoffConfig,
        baseDelayMs: this.backoffConfig.baseDelayMs * this.rateLimitBaseMultiplier,
        maxDelayMs: this.rateLimitMaxDelayMs,
      };
    } else if (classified.category === "auth") {
      config = { ...this.backoffConfig, maxDelayMs: this.authMaxDelayMs };
    } else if (this.hasProlongedOutageNotified) {
      config = { ...this.backoffConfig, maxDelayMs: this.prolongedOutageMaxDelayMs };
    } else {
      config = this.backoffConfig;
    }

    const delay = computeBackoffDelay(this.attempts, config);
    this.attempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  /**
   * Try to establish a new connection and hand it to the caller via
   * {@link onReconnected}. On full success, resets backoff and auth state.
   * On failure, re-enters {@link handleDisconnect} for re-classification
   * (connect error) or schedules a transient retry (onReconnected error).
   * Checks {@link resetVersion} after each async gap to bail if the manager
   * was reset or stopped mid-flight.
   */
  private async attemptReconnect(): Promise<void> {
    if (this.isStopped) return;
    this.isReconnecting = true;
    const resetVer = this.resetVersion;

    let reconnectError: unknown = null;
    let callbackFailed = false;

    try {
      // NOTE: If the caller-supplied connect() hangs (e.g., a broken token
      // refresh in pre-connect), the manager stays in isReconnecting=true
      // and all handleDisconnect calls are silently debounced. imapflow has
      // its own timeouts (CONNECT_TIMEOUT 90s, GREETING_TIMEOUT 16s), but
      // pre-connect work is unguarded. Wrap with Promise.race + a timeout
      // if connect() grows to include async steps beyond imapflow.connect().
      const client = await this.connect();

      // Re-check after async gap: stop() or reset() may have been called
      // while connect() was in-flight. Close the orphaned client and bail.
      if (this.isStopped || this.resetVersion !== resetVer) {
        try {
          client.close();
        } catch (err) {
          // NOTE: Replace with structured logging when available.
          console.warn("failed to close orphaned client", err);
        }
        return;
      }

      try {
        await this.onReconnected(client);
      } catch (cbErr) {
        try {
          client.close();
        } catch (err) {
          // NOTE: Replace with structured logging when available.
          console.warn("failed to close client after onReconnected error", err);
        }
        reconnectError = cbErr;
        callbackFailed = true;
      }

      // Reset only after full success (connect + onReconnected both passed).
      // If onReconnected fails repeatedly, attempts keeps climbing and
      // backoff escalates instead of looping at base delay.
      if (!callbackFailed) {
        this.attempts = 0;
        this.firstAuthFailureAt = null;
        this.firstTransientFailureAt = null;
        this.hasProlongedOutageNotified = false;
      }
    } catch (err) {
      reconnectError = err;
    } finally {
      if (this.resetVersion === resetVer) {
        this.isReconnecting = false;
      }
    }

    // Don't act on errors from a stopped/stale manager.
    if (!reconnectError || this.isStopped || this.resetVersion !== resetVer) return;

    if (callbackFailed) {
      // onReconnected failure is always retryable - the IMAP connection
      // itself succeeded. The error could be non-IMAP (DB, search index),
      // so don't classify it. Schedule directly with backoff.
      this.scheduleReconnect({
        category: "transient",
        message: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
      });
    } else {
      this.handleDisconnect(reconnectError);
    }
  }
}
