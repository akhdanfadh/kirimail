import { ImapFlow } from "imapflow";

/**
 * Credentials needed to connect to an IMAP server.
 *
 * Maps 1:1 to the fields stored (encrypted) in the email_accounts table.
 * Passed to ImapFlow constructor in {@link createImapClient}.
 *
 * @see https://imapflow.com/docs/api/imapflow-client#new-imapflowoptions - accepted auth/connection fields
 */
export interface ImapCredentials {
  /** IMAP server hostname (e.g., "imap.gmail.com"). */
  host: string;
  /** IMAP server port (e.g., 993 for TLS, 143 for STARTTLS). */
  port: number;
  /** True for direct TLS (port 993); false for STARTTLS upgrade (port 143). */
  secure: boolean;
  /** Login username, usually the full email address. */
  user: string;
  /** Login password or app-specific password. */
  pass: string;
}

/**
 * Create an ImapFlow client from credentials. Does not connect.
 *
 * @see https://imapflow.com/docs/api/imapflow-client#new-imapflowoptions
 */
export function createImapClient(creds: ImapCredentials): ImapFlow {
  return new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },

    // Suppress imapflow's built-in console logging; we handle errors at the caller
    logger: false,

    // Current usage is short-lived (connect -> list -> logout), so auto-IDLE
    // between commands is unnecessary overhead.
    // TODO: Remove when long-lived connections need IDLE for real-time sync
    disableAutoIdle: true,

    // Non-TLS connections often use self-signed certs in dev and self-hosted
    // setups, so we only enforce validation for direct TLS.
    // TODO: Make certificate validation configurable per account
    tls: { rejectUnauthorized: creds.secure },
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
