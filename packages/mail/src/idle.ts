import type { ImapFlow } from "imapflow";

import type { IdleClientOptions, ImapCredentials } from "./connection";
import type { ReconnectionManagerOptions } from "./reconnection";

import { createIdleClient } from "./connection";
import { ReconnectionManager } from "./reconnection";

// ---------------------------------------------------------------------------
// Provider IDLE time detection
// ---------------------------------------------------------------------------

/**
 * Default IDLE configuration based on RFC 2177.
 * @see https://datatracker.ietf.org/doc/html/rfc2177
 */
const DEFAULT_IDLE_CONFIG: IdleClientOptions = {
  maxIdleTimeMs: 25 * 60 * 1000, // 25 min (margin below RFC 29-min)
};

/**
 * Provider-specific IDLE overrides, ported from EmailEngine.
 * @see https://github.com/postalsys/emailengine/blob/master/lib/email-client/imap-client.js
 */
const PROVIDER_IDLE_OVERRIDES: Array<{ pattern: RegExp; config: IdleClientOptions }> = [
  { pattern: /\.yahoo\./i, config: { maxIdleTimeMs: 3 * 60 * 1000 } },
  { pattern: /\.rambler\.ru$/i, config: { maxIdleTimeMs: 55_000 } },
  {
    pattern: /\.163\.com$|coremail/i,
    // Coremail/163.com doesn't support real IDLE and ignores NOOP. STATUS is the
    // only command that counts as real activity for the server's idle timer.
    config: { maxIdleTimeMs: 55_000, missingIdleCommand: "STATUS" },
  },
];

/** Detect provider-specific IDLE configuration by hostname. */
export function detectProviderIdleConfig(host: string): IdleClientOptions {
  for (const { pattern, config } of PROVIDER_IDLE_OVERRIDES) {
    if (pattern.test(host)) return config;
  }
  return DEFAULT_IDLE_CONFIG;
}

// ---------------------------------------------------------------------------
// IdleManager
// ---------------------------------------------------------------------------

/** Connection status reported via {@link IdleManagerOptions.onStatusChange}. */
export type IdleConnectionStatus = "connected" | "reconnecting" | "disconnected";

/**
 * New-message notification from the IMAP server, mirror ImapFlow's types.
 * @see https://github.com/postalsys/imapflow/blob/master/lib/imap-flow.d.ts - ExistsEvent
 */
export interface ExistsInfo {
  path: string;
  count: number;
  prevCount: number;
}

/**
 * Message-deletion notification from the IMAP server, mirror ImapFlow's types.
 * @see https://github.com/postalsys/imapflow/blob/master/lib/imap-flow.d.ts - ExpungeEvent
 */
export interface ExpungeInfo {
  path: string;
  /** Sequence number of the expunged message (standard EXPUNGE). */
  seq?: number;
  /** UID of the expunged message (VANISHED response via QRESYNC). */
  uid?: number;
  /** True when the server sent VANISHED (QRESYNC) instead of standard EXPUNGE. */
  vanished: boolean;
  /** True for VANISHED EARLIER — messages expunged before the current session. */
  earlier?: boolean;
}

/**
 * Flag-change notification from the IMAP server, mirror ImapFlow's types.
 * @see https://github.com/postalsys/imapflow/blob/master/lib/imap-flow.d.ts - FlagsEvent
 */
export interface FlagsInfo {
  path: string;
  /** Sequence number of the updated message. */
  seq: number;
  /** UID of the updated message (if the server provided it). */
  uid?: number;
  /** Updated MODSEQ value for the mailbox (CONDSTORE). */
  modseq?: bigint;
  /** Current set of all flags on the message. */
  flags: Set<string>;
  /** Derived flag color (e.g., "red", "yellow") if the message is flagged. */
  flagColor?: string;
}

/** Payload for the reconnection callback. */
export interface ReconnectedInfo {
  /** True if uidNext advanced while disconnected (caller should enqueue catch-up sync). */
  missedMessages: boolean;
}

/** Options for creating an {@link IdleManager}. */
export interface IdleManagerOptions {
  /** Credentials for the IMAP server. */
  credentials: ImapCredentials;
  /** Mailbox to IDLE on (e.g., "INBOX" or "\\All" for Gmail). */
  targetMailbox: string;
  /** Override auto-detected provider IDLE configuration. */
  idleConfig?: IdleClientOptions;
  /**
   * Called when the server reports new messages in the target mailbox.
   * Must be synchronous — async callbacks will have unhandled rejections.
   */
  onExists: (info: ExistsInfo) => void;
  /**
   * Called when the server reports expunged messages in the target mailbox.
   * Must be synchronous — async callbacks will have unhandled rejections.
   */
  onExpunge: (info: ExpungeInfo) => void;
  /**
   * Called when flags change on a message (e.g., read/unread, starred).
   * Must be synchronous — async callbacks will have unhandled rejections.
   */
  onFlags?: (info: FlagsInfo) => void;
  /**
   * Called after reconnection with missed-message detection result.
   * Must be synchronous — async callbacks will have unhandled rejections.
   */
  onReconnected: (info: ReconnectedInfo) => void;
  /** Called on connection status transitions. */
  onStatusChange?: (status: IdleConnectionStatus) => void;
  /** Override default reconnection behavior. */
  reconnectionOptions?: Partial<
    Pick<
      ReconnectionManagerOptions,
      | "backoff"
      | "rateLimitBaseMultiplier"
      | "rateLimitMaxDelayMs"
      | "authDisableThresholdMs"
      | "authMaxDelayMs"
      | "prolongedOutageThresholdMs"
      | "prolongedOutageMaxDelayMs"
      | "onAuthFailure"
      | "onAuthDisabled"
      | "onProtocolError"
      | "onProlongedOutage"
    >
  >;
}

/**
 * Manages a persistent IMAP IDLE connection for real-time push notifications.
 *
 * Owns one ImapFlow client per email account, keeps it in IDLE on the
 * configured mailbox, and forwards `exists`/`expunge`/`flags` events to
 * caller callbacks. On disconnect, delegates to an internal {@link ReconnectionManager}
 * for exponential-backoff recovery and compares `uidNext` to detect missed
 * messages.
 *
 * @example
 * ```ts
 * const idle = new IdleManager({
 *   credentials: decryptedCreds,
 *   targetMailbox: "INBOX",
 *   onExists: (info) => enqueuePartialSync(accountId, info),
 *   onExpunge: (info) => enqueueExpungeSync(accountId, info),
 *   onReconnected: ({ missedMessages }) => {
 *     if (missedMessages) enqueueCatchUpSync(accountId);
 *   },
 * });
 * await idle.start();
 * ```
 *
 * @see https://github.com/postalsys/emailengine/blob/master/lib/email-client/imap-client.js - IDLE lifecycle, provider workarounds
 * @see https://github.com/postalsys/imapflow/blob/master/lib/commands/idle.js - IDLE command internals
 */
export class IdleManager {
  private readonly credentials: ImapCredentials;
  private readonly targetMailbox: string;
  private readonly idleClientOptions: IdleClientOptions;
  private readonly onExists: (info: ExistsInfo) => void;
  private readonly onExpunge: (info: ExpungeInfo) => void;
  private readonly onFlags: ((info: FlagsInfo) => void) | undefined;
  private readonly onIdleReconnected: (info: ReconnectedInfo) => void;
  private readonly onStatusChange: ((status: IdleConnectionStatus) => void) | undefined;

  private reconnectionManager: ReconnectionManager;
  private client: ImapFlow | null = null;
  private lastSeenUidNext: number | null = null;
  private lastSeenUidValidity: bigint | null = null;
  private isStopped = false;
  private isStarting = false;

  constructor(options: IdleManagerOptions) {
    this.credentials = options.credentials;
    this.targetMailbox = options.targetMailbox;
    this.onExists = options.onExists;
    this.onExpunge = options.onExpunge;
    this.onFlags = options.onFlags;
    this.onIdleReconnected = options.onReconnected;
    this.onStatusChange = options.onStatusChange;

    const detected = detectProviderIdleConfig(options.credentials.host);
    this.idleClientOptions = { ...detected, ...options.idleConfig };

    const reconnOpts = options.reconnectionOptions ?? {};

    this.reconnectionManager = new ReconnectionManager({
      connect: async () => {
        const client = createIdleClient(this.credentials, this.idleClientOptions);
        await client.connect();
        return client;
      },
      onReconnected: async (client) => {
        await this.handleReconnected(client);
      },
      ...reconnOpts,
    });
  }

  /**
   * Establish the initial IMAP connection, SELECT the target mailbox, and
   * begin IDLE monitoring.
   *
   * Throws if the initial connection or SELECT fails — the caller (worker)
   * decides whether to retry or mark the account as unhealthy. This is
   * intentionally different from mid-session disconnects, which are handled
   * automatically by the internal {@link ReconnectionManager}.
   */
  async start(): Promise<void> {
    if (this.client || this.isStarting) {
      throw new Error("IdleManager already started — call stop() first");
    }
    this.isStarting = true;
    this.isStopped = false;
    this.reconnectionManager.reset();

    let client: ImapFlow | undefined;
    try {
      client = createIdleClient(this.credentials, this.idleClientOptions);
      await client.connect();

      if (this.isStopped) {
        client.close();
        return;
      }

      const mailbox = await client.mailboxOpen(this.targetMailbox);

      if (this.isStopped) {
        client.close();
        return;
      }

      this.client = client;
      this.lastSeenUidNext = mailbox.uidNext;
      this.lastSeenUidValidity = mailbox.uidValidity;

      this.wireEvents(client);
      this.startIdle(client);
      this.emitStatus("connected");
    } catch (err) {
      try {
        client?.close();
      } catch {
        // Already closed — safe to ignore.
      }
      throw err;
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Gracefully stop IDLE monitoring and close the connection.
   * Idempotent — safe to call multiple times or after an error.
   */
  stop(): void {
    this.isStopped = true;
    this.reconnectionManager.stop();
    this.cleanupClient();
    this.emitStatus("disconnected");
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Start IDLE immediately rather than waiting for imapflow's 15-second
   * auto-IDLE timer. Fire-and-forget: `idle()` resolves when IDLE
   * permanently breaks (handled via close/error events). Internally,
   * imapflow's `runIdleLoop` handles maxIdleTime restart automatically.
   */
  private startIdle(client: ImapFlow): void {
    client.idle().catch(() => {
      // IDLE rejection is handled via the 'error' and 'close' event listeners.
    });
  }

  /**
   * Wire `exists`, `expunge`, `flags`, `error`, and `close` event listeners
   * on a client. Called once for the initial connection and again after each
   * successful reconnection (new client = new EventEmitter).
   */
  private wireEvents(client: ImapFlow): void {
    client.on("exists", (event) => {
      try {
        this.onExists(event);
      } catch (err) {
        // NOTE: Replace with structured logging when available.
        console.warn("onExists callback threw", err);
      }
    });

    client.on("expunge", (event) => {
      try {
        this.onExpunge(event);
      } catch (err) {
        // NOTE: Replace with structured logging when available.
        console.warn("onExpunge callback threw", err);
      }
    });

    if (this.onFlags) {
      const onFlags = this.onFlags;
      client.on("flags", (event) => {
        try {
          onFlags(event);
        } catch (err) {
          // NOTE: Replace with structured logging when available.
          console.warn("onFlags callback threw", err);
        }
      });
    }

    // Track the last error so we can pass it to handleDisconnect when the
    // close event fires. imapflow emits 'error' before 'close' when a
    // connection-level error occurs; a clean close emits only 'close'.
    let lastError: unknown = null;
    client.on("error", (err: Error) => {
      lastError = err;
    });

    client.on("close", () => {
      if (this.isStopped) return;
      this.emitStatus("reconnecting");
      this.reconnectionManager.handleDisconnect(lastError);
    });
  }

  /** Remove all listeners and close the current client. */
  private cleanupClient(): void {
    if (!this.client) return;
    try {
      this.client.removeAllListeners();
      this.client.close();
    } catch {
      // Already closed or errored — safe to ignore during cleanup.
    }
    this.client = null;
  }

  /**
   * Called by the {@link ReconnectionManager} after a successful reconnect.
   * Replaces the current client, SELECTs the target mailbox, detects missed
   * messages via uidNext comparison, and re-wires event listeners.
   */
  private async handleReconnected(newClient: ImapFlow): Promise<void> {
    // Clean up the old client before adopting the new one.
    this.cleanupClient();

    if (this.isStopped) {
      try {
        newClient.close();
      } catch {
        // Already closed — safe to ignore.
      }
      return;
    }

    const mailbox = await newClient.mailboxOpen(this.targetMailbox);

    // Re-check after async gap: stop() may have been called while
    // mailboxOpen was in-flight. Close the orphaned client and bail.
    if (this.isStopped) {
      try {
        newClient.close();
      } catch {
        // Already closed — safe to ignore.
      }
      return;
    }

    // UIDs are only comparable within the same UIDVALIDITY epoch (RFC 3501).
    // A UIDVALIDITY change means the server rebuilt the mailbox — all cached
    // UIDs are invalid and a full resync is needed.
    const validityChanged =
      this.lastSeenUidValidity !== null && mailbox.uidValidity !== this.lastSeenUidValidity;
    const uidNextAdvanced = this.lastSeenUidNext !== null && mailbox.uidNext > this.lastSeenUidNext;
    const missedMessages = validityChanged || uidNextAdvanced;

    this.client = newClient;
    this.lastSeenUidNext = mailbox.uidNext;
    this.lastSeenUidValidity = mailbox.uidValidity;

    this.wireEvents(newClient);
    this.startIdle(newClient);
    this.emitStatus("connected");

    try {
      this.onIdleReconnected({ missedMessages });
    } catch (err) {
      // NOTE: Replace with structured logging when available.
      console.warn("onReconnected callback threw", err);
    }
  }

  private emitStatus(status: IdleConnectionStatus): void {
    try {
      this.onStatusChange?.(status);
    } catch (err) {
      // NOTE: Replace with structured logging when available.
      console.warn("onStatusChange callback threw", err);
    }
  }
}
