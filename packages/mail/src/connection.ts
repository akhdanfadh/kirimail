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
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}
