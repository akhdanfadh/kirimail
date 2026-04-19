import { ImapConnectionCache } from "@kirimail/mail";

/**
 * Shared worker-process connection caches.
 *
 * One instance per worker process, shared across all handlers that need IMAP
 * access. Sharing means a connection established by one handler (e.g.,
 * imap-command's write-back) can be reused by another (e.g., append-sent's
 * Sent-folder APPEND) targeting the same account.
 */
export const imapCache = new ImapConnectionCache();

/** Close all cached connections. Call during graceful shutdown. Idempotent. */
export function closeCachedConnections(): void {
  imapCache.closeAll();
}
