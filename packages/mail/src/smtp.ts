import type { Transporter } from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";

import { createHash } from "node:crypto";
import { createTransport } from "nodemailer";

import { stripBcc } from "./compose";

/**
 * TLS mode for SMTP connections. Maps directly to `smtp_identities.smtpSecurity`.
 *
 * - "tls" - Direct TLS on connect (typically port 465). The connection is
 *   encrypted from the first byte.
 * - "starttls" - Plaintext connect, then upgrade via STARTTLS (typically
 *   port 587). The upgrade is required - the connection fails if the server
 *   doesn't support STARTTLS, preventing plaintext credential transmission.
 * - "none" - Plaintext with no TLS upgrade. Credentials are sent unencrypted.
 *   NOTE: Exists for development/test servers only. The add-account UI
 *   should warn or disallow "none" in production deployments.
 */
export type SmtpSecurity = "tls" | "starttls" | "none";

/** Credentials needed to connect to an SMTP server. */
export interface SmtpCredentials {
  /** SMTP server hostname (e.g., "smtp.gmail.com"). */
  host: string;
  /** SMTP server port (e.g., 465 for TLS, 587 for STARTTLS). */
  port: number;
  /** TLS mode for the connection. See {@link SmtpSecurity}. */
  security: SmtpSecurity;
  /** SMTP authentication credentials. */
  auth: { user: string; pass: string };
  /**
   * Whether to validate the server's TLS certificate. Default: `true`.
   *
   * Set to `false` only for servers with self-signed or otherwise invalid
   * certificates (common in development and some self-hosted setups).
   * Disabling validation makes the connection vulnerable to MITM attacks.
   */
  rejectUnauthorized?: boolean;
}

/** SMTP envelope: sender + all recipient addresses. */
export interface SmtpEnvelope {
  from: string;
  to: string[];
}

/** Result of a successful {@link SmtpTransportCache.send}. */
export interface SmtpSendResult {
  /** Recipient addresses accepted by the SMTP server. */
  accepted: string[];
  /** Recipient addresses rejected by the SMTP server. */
  rejected: string[];
  /** Message-ID assigned by the transport. */
  messageId: string;
  /** Final SMTP server response string. */
  response: string;
  // NOTE: Nodemailer also returns this with per-recipient failure details
  // (response code, SMTP command). Omitted here because the send pipeline
  // only needs *which* addresses failed, not *why* per address.
  // Per-recipient retry classification is a future concern - adding the
  // optional field later is a non-breaking change.
  // rejectedErrors?: SMTPError[]
}

/** Options for {@link SmtpTransportCache}. */
export interface SmtpTransportCacheOptions {
  /**
   * How long (ms) a transport with no pending sends stays open before
   * eviction. Default: 5 min.
   *
   * SMTP sends come in bursts (compose -> send -> compose -> send), so a
   * longer window than IMAP (60s) avoids reopening the pool between sends.
   */
  inactivityTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Transport cache
// ---------------------------------------------------------------------------

/**
 * Per-account cache of nodemailer pool transports. Reuses transports
 * across consecutive sends for the same email account, avoiding repeated
 * TLS handshakes during send bursts.
 *
 * Concurrent-safe via reference counting - the inactivity timer only
 * starts when the last in-flight send completes.
 *
 * Adapted from EmailEngine's SMTP pool manager, simplified for
 * single-connection-per-account usage in a self-hosted email client.
 *
 * @see https://github.com/postalsys/emailengine/blob/master/lib/email-client/smtp-pool-manager.js
 *
 * @example
 * ```ts
 * const cache = new SmtpTransportCache();
 * const result = await cache.send(emailAccountId, creds, rawMessage, envelope);
 * ```
 */
export class SmtpTransportCache {
  private readonly inactivityTimeoutMs: number;

  /** Pool transports keyed by email account ID, with their inactivity eviction timer. */
  private readonly active = new Map<
    string,
    {
      transport: Transporter<SMTPPool.SentMessageInfo>;
      timer: NodeJS.Timeout | null;
      /** Fingerprint of the credentials used to create this transport. */
      credsFingerprint: string;
    }
  >();
  /** Number of in-flight {@link send} calls per account. Timer only starts when this reaches 0. */
  private readonly inflight = new Map<string, number>();
  /** Set by {@link closeAll} - once closed, the cache rejects all new {@link send} calls. */
  private isClosed = false;

  constructor(options?: SmtpTransportCacheOptions) {
    this.inactivityTimeoutMs = options?.inactivityTimeoutMs ?? 5 * 60 * 1000;
  }

  /**
   * Send raw MIME bytes via SMTP. BCC headers are stripped automatically
   * before transmission - the caller can pass the original
   * {@link buildRawMessage} output directly.
   *
   * If `creds` differ from the cached transport's credentials, the stale
   * transport is evicted and a fresh one is created automatically.
   */
  async send(
    emailAccountId: string,
    creds: SmtpCredentials,
    raw: Buffer,
    envelope: SmtpEnvelope,
  ): Promise<SmtpSendResult> {
    // Terminal after closeAll()
    if (this.isClosed) {
      throw new Error("SmtpTransportCache is closed");
    }

    const stripped = await stripBcc(raw);
    if (this.isClosed) {
      throw new Error("SmtpTransportCache is closed");
    }

    const transport = this.getOrCreate(emailAccountId, creds);

    // Suspend inactivity timer while a send is in-flight
    const entry = this.active.get(emailAccountId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    this.inflight.set(emailAccountId, (this.inflight.get(emailAccountId) ?? 0) + 1);

    try {
      const info = await transport.sendMail({
        raw: stripped,
        envelope: { from: envelope.from, to: envelope.to },
      });
      return {
        accepted: info.accepted,
        rejected: info.rejected,
        messageId: info.messageId,
        response: info.response,
      };
    } finally {
      const count = this.inflight.get(emailAccountId)! - 1;
      if (count <= 0) {
        this.inflight.delete(emailAccountId);
        this.resetTimer(emailAccountId);
      } else {
        this.inflight.set(emailAccountId, count);
      }
    }
  }

  /**
   * Close a single cached transport (e.g., after account disconnect).
   * The next {@link send} call for this account creates a fresh transport.
   * Idempotent.
   *
   * Not needed for credential rotation - {@link send} auto-evicts on
   * credential mismatch.
   */
  close(emailAccountId: string): void {
    this.evict(emailAccountId);
  }

  /**
   * Close all cached transports and mark the cache terminal. Subsequent
   * {@link send} calls throw. Idempotent.
   */
  closeAll(): void {
    this.isClosed = true;
    for (const [id] of this.active) this.evict(id);
    // inflight is NOT cleared - in-flight operations decrement naturally,
    // and clearing would corrupt counts if a new send() call arrives
    // between closeAll and the in-flight operation's finally block.
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Return a cached transport if one exists with matching credentials,
   * otherwise create one. Auto-evicts on credential mismatch so stale
   * transports are never silently reused after credential rotation.
   *
   * `createTransport()` is synchronous, so concurrent callers naturally
   * get the same transport - no async dedup needed.
   */
  private getOrCreate(id: string, creds: SmtpCredentials): Transporter<SMTPPool.SentMessageInfo> {
    const fingerprint = SmtpTransportCache.credsFingerprint(creds);
    const existing = this.active.get(id);
    if (existing) {
      if (existing.credsFingerprint === fingerprint) return existing.transport;
      // Credentials changed - evict stale transport so the new one
      // picks up the rotated password / changed host / etc.
      this.evict(id);
    }

    const options: SMTPPool.Options & { maxRequeues?: number } = {
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      // Caps pool-internal retries when a connection drops mid-send.
      // This is the fast-recovery layer: 3 immediate retries for transient
      // network blips (resolve in ms, no backoff). If still failing, the
      // sendMail promise rejects and pg-boss handles job-level retry with
      // exponential backoff. Total worst case: 3 pool requeues × N pg-boss
      // attempts, but the pool requeues add negligible overhead (~100ms)
      // compared to pg-boss backoff delays. (default -1 = unlimited, which
      // would hide failures from pg-boss indefinitely)
      maxRequeues: 3,
      // Outlive the cache inactivity timer so idle TCP connections stay warm
      // for the entire cache window. The cache always evicts first (clean
      // teardown); this timeout only fires as a safety net for hung
      // connections during active sends.
      socketTimeout: this.inactivityTimeoutMs + 30_000,
      host: creds.host,
      port: creds.port,
      secure: creds.security === "tls",
      requireTLS: creds.security === "starttls",
      ignoreTLS: creds.security === "none",
      auth: creds.auth,
      tls: {
        rejectUnauthorized: creds.rejectUnauthorized ?? true,
        // NOTE: tls.servername defaults to `host`, which fails for IP-based
        // connections where the cert CN doesn't match. Add per-account
        // servername override if self-hosted users need it.
        // servername: ...
      },
      logger: false,
    };
    const transport = createTransport(options);

    // SMTPPool in nodemailer v8 never emits 'error' (errors route to
    // individual sendMail callbacks), but this is an implementation detail.
    // If a future version emits pool-wide errors, this listener self-heals
    // the cache by evicting the broken transport. Identity check prevents
    // a stale transport's error from evicting a newer replacement.
    transport.on("error", () => {
      if (this.active.get(id)?.transport === transport) this.evict(id);
    });

    this.active.set(id, { transport, timer: null, credsFingerprint: fingerprint });
    return transport;
  }

  /**
   * Irreversible hash of credential fields that affect the transport.
   * Used only for equality comparison - avoids storing raw passwords
   * in the long-lived cache entries.
   */
  private static credsFingerprint(creds: SmtpCredentials): string {
    return createHash("sha256")
      .update(
        [
          creds.host,
          creds.port,
          creds.security,
          creds.auth.user,
          creds.auth.pass,
          creds.rejectUnauthorized ?? true,
        ].join("\0"),
      )
      .digest("hex");
  }

  /**
   * (Re)start the inactivity eviction timer for a cached transport.
   * No-op if the entry was already evicted.
   */
  private resetTimer(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    const timer = setTimeout(() => this.evict(id), this.inactivityTimeoutMs);
    timer.unref();
    entry.timer = timer;
  }

  /**
   * Remove and close a cached transport. Deletes from the map before
   * calling close() to prevent reentrant eviction.
   */
  private evict(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.transport.close();
    } catch {
      // Already closed - safe to ignore.
    }
  }
}
