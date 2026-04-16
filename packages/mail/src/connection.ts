import { ImapFlow } from "imapflow";

/** Credentials needed to connect to an IMAP server. */
export interface ImapCredentials {
  /** IMAP server hostname (e.g., "imap.gmail.com"). */
  host: string;
  /** IMAP server port (e.g., 993 for TLS, 143 for STARTTLS). */
  port: number;
  /**
   * True for direct TLS (port 993); false for STARTTLS upgrade (port 143).
   *
   * When false, imapflow connects in plaintext and upgrades via STARTTLS if
   * the server advertises it, but does not require it - a server that omits
   * STARTTLS (misconfigured or MITM downgrade) will proceed unencrypted.
   * Enforce STARTTLS via imapflow's `doSTARTTLS: true` option when strict
   * security is needed.
   *
   * NOTE: SmtpCredentials uses `security: "tls" | "starttls"` instead of
   * a boolean - more expressive and maps directly to the DB column. Adopt
   * the same pattern here for consistency across IMAP and SMTP credentials.
   */
  secure: boolean;
  /** Login username, usually the full email address. */
  user: string;
  /** Login password or app-specific password. */
  pass: string;
}

/**
 * Create an ImapFlow client from credentials. Does not connect.
 *
 * Use this for short-lived connections (connect -> list/sync -> logout)
 * that don't need auto-IDLE between commands. For long-lived IDLE
 * monitoring, use {@link createIdleClient}.
 *
 * @see https://imapflow.com/docs/api/imapflow-client#new-imapflowoptions
 */
export function createImapClient(creds: ImapCredentials): ImapFlow {
  return new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    // NOTE: Make certificate validation configurable per account - tying it
    // to `secure` is a rough heuristic (skips validation for STARTTLS connections)
    tls: { rejectUnauthorized: creds.secure },

    // Auto-IDLE between commands is unnecessary overhead in short-lived connections
    disableAutoIdle: true,

    // Suppress imapflow's built-in console logging; we handle errors at the caller
    logger: false,
  });
}

/** Options for {@link createIdleClient} beyond credentials. */
export interface IdleClientOptions {
  /** IDLE restart interval in ms. Defaults to 25 min. */
  maxIdleTimeMs?: number;
  /** Fallback command when server doesn't support IDLE. Defaults to "NOOP". */
  missingIdleCommand?: "NOOP" | "STATUS" | "SELECT";
}

/**
 * Create an ImapFlow client for persistent IDLE monitoring. Does not connect.
 *
 * Unlike {@link createImapClient}, this client has auto-IDLE enabled so
 * imapflow enters IDLE automatically after SELECT + 15s of inactivity.
 */
export function createIdleClient(creds: ImapCredentials, options?: IdleClientOptions): ImapFlow {
  return new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    tls: { rejectUnauthorized: creds.secure },
    disableAutoIdle: false,
    maxIdleTime: options?.maxIdleTimeMs ?? 25 * 60 * 1000,
    missingIdleCommand: options?.missingIdleCommand,
    logger: false,
  });
}

/** Connect, run a callback, then logout. Handles cleanup on error. */
export async function withImapConnection<T>(
  creds: ImapCredentials,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImapClient(creds);
  await client.connect();
  // imapflow emits 'error' synchronously before scheduling close() via
  // setImmediate. Without a listener, Node throws an uncaught exception.
  // The error already propagates through fn()'s rejected promise.
  // NOTE: Replace with structured logging when available.
  client.on("error", (err: Error) => {
    console.warn("[imap] connection error:", err.message);
  });
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // Socket already destroyed - nothing to clean up
    }
  }
}

// ---------------------------------------------------------------------------
// Connection cache
// ---------------------------------------------------------------------------

/** Options for {@link ImapConnectionCache}. */
export interface ImapConnectionCacheOptions {
  /**
   * How long (ms) a connection with no pending operations stays open before
   * eviction. Default: 60 s.
   *
   * Cached connections send no keepalive, so values above imapflow's 5-min
   * `socketTimeout` are ineffective - the connection will be closed by
   * imapflow before the timer fires. Broken connections reconnect
   * transparently on next use, but shorter values avoid the overhead.
   */
  inactivityTimeoutMs?: number;
}

/**
 * Reuses IMAP connections across consecutive operations for the same email account.
 *
 * Persistent-session counterpart to {@link withImapConnection}: where that
 * helper opens a fresh connection per call, this cache keeps connections warm
 * and reuses them until an inactivity timeout fires.
 *
 * Concurrent-safe: multiple async callers sharing the same email account await
 * the same connection promise (no duplicate connects), and a reference counter
 * prevents the inactivity timer from firing while operations are in-flight.
 *
 * Broken connections are evicted automatically via imapflow's `close` event -
 * command-level errors (e.g., UID not found) do NOT evict, because the
 * connection itself is still usable.
 *
 * @example
 * ```ts
 * const cache = new ImapConnectionCache();
 * await cache.execute(emailAccountId, creds, (client) =>
 *   storeFlags(client, { mailbox: "INBOX", uids: [1], flags: ["\\Seen"], operation: "add" }),
 * );
 * ```
 */
export class ImapConnectionCache {
  private readonly inactivityTimeoutMs: number;

  /** Connected clients keyed by email account ID, with their inactivity eviction timer. */
  private readonly active = new Map<string, { client: ImapFlow; timer: NodeJS.Timeout | null }>();
  /** In-flight connection promises for deduplication - concurrent callers for the same account await the same promise. */
  private readonly connecting = new Map<string, Promise<ImapFlow>>();
  /** Number of in-flight {@link execute} calls per account. Timer only starts when this reaches 0. */
  private readonly inflight = new Map<string, number>();
  /** Incremented by {@link closeAll} to invalidate in-flight connect() calls. */
  private resetVersion = 0;
  /** Per-account version - incremented by {@link close} to invalidate in-flight connect() for that account. */
  private readonly accountResetVersion = new Map<string, number>();

  constructor(options?: ImapConnectionCacheOptions) {
    this.inactivityTimeoutMs = options?.inactivityTimeoutMs ?? 60_000;
  }

  /**
   * Run `fn` on a cached (or freshly created) connection for the given email account.
   *
   * Connection lifecycle:
   * 1. Get existing connection or create one (deduped across concurrent callers).
   * 2. Suspend the inactivity timer while in-flight; increment refcount.
   * 3. Run `fn(client)`.
   * 4. Decrement refcount; restart inactivity timer when the last caller finishes.
   */
  async execute<T>(
    emailAccountId: string,
    creds: ImapCredentials,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = await this.getOrConnect(emailAccountId, creds);

    // Suspend inactivity timer while an operation is in-flight
    const entry = this.active.get(emailAccountId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    this.inflight.set(emailAccountId, (this.inflight.get(emailAccountId) ?? 0) + 1);

    try {
      return await fn(client);
    } finally {
      const count = this.inflight.get(emailAccountId)! - 1;
      if (count <= 0) {
        this.inflight.delete(emailAccountId);
        // resetTimer returns early if there's no active entry (evicted
        // and not replaced). If the connection was replaced during fn(),
        // this correctly sets the timer on the replacement - which has
        // no in-flight callers and needs an inactivity timer.
        this.resetTimer(emailAccountId);
      } else {
        this.inflight.set(emailAccountId, count);
      }
    }
  }

  /**
   * Close a single cached connection (e.g., after credential rotation or
   * account disconnect). The next {@link execute} call for this account
   * creates a fresh connection. Idempotent - no-op if the account has no
   * cached connection.
   *
   * Invalidates any in-flight connect() for this account so the stale
   * connection is discarded rather than overwriting a newer replacement.
   */
  close(emailAccountId: string): void {
    this.accountResetVersion.set(
      emailAccountId,
      (this.accountResetVersion.get(emailAccountId) ?? 0) + 1,
    );
    this.connecting.delete(emailAccountId);
    this.evict(emailAccountId);
  }

  /** Close all cached connections and invalidate in-flight connect attempts. Idempotent. */
  closeAll(): void {
    this.resetVersion++;
    for (const [id] of this.active) this.evict(id);
    this.connecting.clear();
    // inflight is NOT cleared - in-flight operations decrement naturally,
    // and clearing would corrupt counts if a new execute() call arrives
    // between closeAll and the in-flight operation's finally block.
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Return a cached client if one exists, otherwise connect (deduped -
   * concurrent callers for the same account await the same connection
   * promise, so only one TLS handshake + AUTH occurs).
   */
  private async getOrConnect(id: string, creds: ImapCredentials): Promise<ImapFlow> {
    const existing = this.active.get(id);
    if (existing) return existing.client;

    // Concurrent callers for the same email account await the SAME promise
    let promise = this.connecting.get(id);
    if (!promise) {
      promise = this.connect(id, creds);
      this.connecting.set(id, promise);
    }
    try {
      return await promise;
    } catch (err) {
      if (this.connecting.get(id) === promise) this.connecting.delete(id);
      throw err;
    }
  }

  /**
   * Create and connect a new ImapFlow client. After the async connect()
   * resolves, checks {@link resetVersion}/{@link accountResetVersion} to
   * detect if {@link closeAll} or {@link close} was called mid-flight -
   * if so, the connection is discarded. Wires error and close listeners
   * before storing in {@link active}.
   */
  private async connect(id: string, creds: ImapCredentials): Promise<ImapFlow> {
    const version = this.resetVersion;
    const accountVersion = this.accountResetVersion.get(id) ?? 0;
    const client = createImapClient(creds);
    await client.connect();

    // closeAll() increments resetVersion, close(id) increments accountResetVersion.
    // If either changed while we were awaiting, this connection is orphaned -
    // discard it so it doesn't overwrite a newer replacement in the active map.
    if (
      this.resetVersion !== version ||
      (this.accountResetVersion.get(id) ?? 0) !== accountVersion
    ) {
      try {
        client.close();
      } catch {
        // Already closed - safe to ignore.
      }
      throw new Error("Connection discarded: cache closed during connect");
    }

    // imapflow emits error before close on socket failures. Without a
    // listener, Node throws an uncaught exception and crashes the process.
    // The close listener handles cleanup - this just absorbs the error.
    // NOTE: Replace with structured logging when available.
    client.on("error", (err: Error) => {
      console.warn(`[imap-cache] connection error for ${id}:`, err.message);
    });

    // Proactive eviction on unexpected disconnect (server BYE, network drop,
    // imapflow's 5-min socketTimeout -> ETIMEOUT). Identity check prevents a
    // stale client's close event from evicting a newer replacement.
    client.on("close", () => {
      if (this.active.get(id)?.client === client) this.evict(id);
    });

    this.active.set(id, { client, timer: null });
    this.connecting.delete(id);
    return client;
  }

  /**
   * (Re)start the inactivity eviction timer for a cached connection.
   * No-op if the entry was already evicted.
   * */
  private resetTimer(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    const timer = setTimeout(() => this.evict(id), this.inactivityTimeoutMs);
    // Don't let eviction timers prevent process exit during shutdown.
    timer.unref();
    entry.timer = timer;
  }

  /**
   * Remove and close a cached connection. Deletes from the map before
   * calling close() to prevent reentrant eviction from the close listener.
   *
   * Uses close() (socket destroy) rather than logout() (IMAP LOGOUT command)
   * because evict is called from non-awaitable contexts (setTimeout callback,
   * EventEmitter listener). Servers handle dropped connections routinely.
   */
  private evict(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.client.close();
    } catch {
      // Already closed - safe to ignore.
    }
  }
}
