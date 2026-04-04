import { ImapFlow } from "imapflow";

import type { ImapCredentials } from "./types";

/**
 * Create an ImapFlow client from credentials. Does not connect.
 *
 * @see https://imapflow.com/docs/api/imapflow-client#new-imapflowoptions — constructor options
 */
export function createImapClient(creds: ImapCredentials): ImapFlow {
  return new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },

    // Suppress imapflow's built-in console logging; we handle errors at the caller
    logger: false,

    // Current usage is short-lived (connect → list → logout), so auto-IDLE
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
