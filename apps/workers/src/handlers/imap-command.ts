import type { FlagOperation } from "@kirimail/mail";
import type { Job, PgBoss } from "pg-boss";

import { db, getEmailAccountById } from "@kirimail/db";
import {
  expungeMessages,
  ImapPrimitiveNonRetriableError,
  moveMessages,
  storeFlags,
} from "@kirimail/mail";

import { imapCache } from "../caches";
import { resolveImapCredentials } from "../credentials";

// ---------------------------------------------------------------------------
// Queue registration
// ---------------------------------------------------------------------------

/**
 * imap-command job data: the @kirimail/mail input shapes narrowed for
 * pg-boss JSON serialization, with `emailAccountId` and a type discriminator.
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
        // Deterministic failures (bad input, permanent server NO swallowed
        // by imapflow) won't change on retry - mark the job complete so
        // pg-boss doesn't burn 3x retry slots on a poisoned job.
        // NOTE: This is NOT pg-boss dead-lettering - returning here marks
        // the job successful, so it leaves no DLQ entry and no failure
        // metric. If a real DLQ is wired up later, throw a typed error
        // pg-boss can route there instead.
        if (error instanceof ImapPrimitiveNonRetriableError) {
          console.error(
            `[imap-command] ${job.data.type} for account ${emailAccountId} discarded (deterministic failure, non-retriable):`,
            error.message,
          );
          return;
        }
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
 * Resolve credentials, acquire a cached IMAP connection, and dispatch the
 * command. Returns early (logged) on the soft `uid-validity-stale` decline -
 * the sync pipeline reconciles, the next user action enqueues a fresh job.
 *
 * Error propagation follows the @kirimail/mail error model (see commands.ts
 * module header): raw throws bubble to pg-boss for retry; non-retriable
 * throws are caught and discarded by the outer handler.
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

  await imapCache.execute(data.emailAccountId, creds, async (client) => {
    switch (data.type) {
      case "store-flags": {
        const result = await storeFlags(client, {
          mailbox: data.mailbox,
          uids: data.uids,
          flags: data.flags,
          operation: data.operation,
          expectedUidValidity: data.uidValidity,
        });
        if (!result.ok) {
          console.warn(
            `[imap-command] store-flags skipped (uid-validity stale) for account ${data.emailAccountId} mailbox "${data.mailbox}"`,
          );
        }
        break;
      }
      case "move": {
        // NOTE: The UID map (source->destination via UIDPLUS) is intentionally
        // discarded - DB UID reconciliation is the sync pipeline's responsibility
        // (see syncMailboxOnConnection in @kirimail/mail). Chained commands
        // targeting the new UID are resolved at the oRPC procedure layer, which
        // reads the DB after sync has reconciled.
        const result = await moveMessages(client, {
          mailbox: data.mailbox,
          destination: data.destination,
          uids: data.uids,
          expectedUidValidity: data.uidValidity,
        });
        if (!result.ok) {
          console.warn(
            `[imap-command] move skipped (uid-validity stale) for account ${data.emailAccountId} mailbox "${data.mailbox}" -> "${data.destination}"`,
          );
        }
        break;
      }
      case "expunge": {
        const result = await expungeMessages(client, {
          mailbox: data.mailbox,
          uids: data.uids,
          expectedUidValidity: data.uidValidity,
        });
        if (!result.ok) {
          console.warn(
            `[imap-command] expunge skipped (uid-validity stale) for account ${data.emailAccountId} mailbox "${data.mailbox}"`,
          );
        }
        break;
      }
    }
  });
}
