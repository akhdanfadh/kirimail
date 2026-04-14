import type { FlagOperation } from "@kirimail/mail";
import type { Job, PgBoss } from "pg-boss";

import { db, getEmailAccountById } from "@kirimail/db";
import { expungeMessages, ImapConnectionCache, moveMessages, storeFlags } from "@kirimail/mail";

import { resolveImapCredentials } from "./credentials";

// ---------------------------------------------------------------------------
// Queue registration
// ---------------------------------------------------------------------------

/**
 * imap-command job data.
 *
 * Mirrors StoreFlagsInput / MoveMessagesInput / ExpungeMessagesInput from
 * @kirimail/mail, narrowed for pg-boss JSON serialization and extended with
 * emailAccountId + type discriminator.
 */
type ImapCommandJobData =
  | {
      type: "store-flags";
      emailAccountId: string;
      mailbox: string;
      uids: number[];
      flags: string[];
      operation: FlagOperation;
      uidValidity?: number;
    }
  | {
      type: "move";
      emailAccountId: string;
      mailbox: string;
      destination: string;
      uids: number[];
      uidValidity?: number;
    }
  | {
      type: "expunge";
      emailAccountId: string;
      mailbox: string;
      uids: number[];
      uidValidity?: number;
    };

/** Register the imap-command queue and handler. */
export async function registerImapCommand(boss: PgBoss): Promise<void> {
  await boss.createQueue("imap-command", {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // Safe to retry after expiry - all three IMAP commands are idempotent.
    expireInSeconds: 120,
  });

  // NOTE: localConcurrency: 5 lets up to 5 accounts have IMAP commands
  // in-flight simultaneously. Jobs for the same account serialize through
  // the connection cache, so increasing this primarily helps multi-account
  // throughput. Hardcoded - no need for per-deployment tuning until usage
  // data or localGroupConcurrency-based fairness suggests otherwise.
  await boss.work(
    "imap-command",
    { batchSize: 1, localConcurrency: 5 },
    async (jobs: Job<ImapCommandJobData>[]): Promise<void> => {
      const job = jobs[0]!;
      const { emailAccountId } = job.data;
      console.log(`[imap-command] processing ${job.data.type} for account ${emailAccountId}`);

      try {
        await executeImapCommand(job.data);
      } catch (error) {
        console.error(
          `[imap-command] ${job.data.type} for account ${emailAccountId} failed:`,
          error,
        );
        throw error;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Connection cache (module-level, lives for the worker process lifetime).
 *
 * Eviction timers use unref() so they don't block process exit, but
 * connections are socket-destroyed rather than cleanly logged out.
 */
const connections = new ImapConnectionCache();

/** Close all cached IMAP connections. Call during graceful shutdown. */
export function closeImapConnections(): void {
  connections.closeAll();
}

/**
 * Resolve credentials, acquire a cached IMAP connection, and dispatch
 * the command. Returns normally on success or when the job should be
 * silently discarded (empty UIDs, deleted account). Throws on transient
 * errors so pg-boss can retry.
 */
async function executeImapCommand(data: ImapCommandJobData): Promise<void> {
  // No UIDs means nothing to do - skip the DB lookup and connection overhead.
  if (data.uids.length === 0) {
    console.warn(
      `[imap-command] ${data.type} with empty UIDs for account ${data.emailAccountId}, skipping`,
    );
    return;
  }

  const account = await getEmailAccountById(db, data.emailAccountId);
  if (!account) {
    // Account was deleted - no point retrying
    console.warn(`[imap-command] account ${data.emailAccountId} not found, skipping`);
    return;
  }

  // Credentials are re-derived per job rather than cached alongside the
  // connection - re-reading ensures we use the latest after key rotation,
  // and AES-GCM decryption is sub-millisecond anyway.
  const creds = resolveImapCredentials(account);

  await connections.execute(data.emailAccountId, creds, async (client) => {
    switch (data.type) {
      case "store-flags": {
        const ok = await storeFlags(client, {
          mailbox: data.mailbox,
          uids: data.uids,
          flags: data.flags,
          operation: data.operation,
          expectedUidValidity: data.uidValidity,
        });
        if (!ok) {
          console.warn(
            `[imap-command] store-flags rejected by server for account ${data.emailAccountId} mailbox "${data.mailbox}"`,
          );
        }
        break;
      }
      case "move": {
        // NOTE: The UID map (source->destination via UIDPLUS) is intentionally
        // discarded - DB UID reconciliation is the sync pipeline's responsibility.
        // Chained commands targeting the new UID are resolved at the API layer.
        const { moved } = await moveMessages(client, {
          mailbox: data.mailbox,
          destination: data.destination,
          uids: data.uids,
          expectedUidValidity: data.uidValidity,
        });
        if (!moved) {
          console.warn(
            `[imap-command] move rejected by server for account ${data.emailAccountId} mailbox "${data.mailbox}" -> "${data.destination}"`,
          );
        }
        break;
      }
      case "expunge": {
        const ok = await expungeMessages(client, {
          mailbox: data.mailbox,
          uids: data.uids,
          expectedUidValidity: data.uidValidity,
        });
        if (!ok) {
          console.warn(
            `[imap-command] expunge rejected by server for account ${data.emailAccountId} mailbox "${data.mailbox}"`,
          );
        }
        break;
      }
    }
  });
}
