import type { Job, PgBoss } from "pg-boss";

import {
  db,
  deleteOutboundMessage,
  findMailboxPathByRole,
  getEmailAccountById,
  getOutboundMessageById,
} from "@kirimail/db";
import { appendToSentFolder, ImapPrimitiveNonRetriableError } from "@kirimail/mail";

import { imapCache } from "../caches";
import { resolveImapCredentials } from "../credentials";

/**
 * Job payload for append-sent. The row is the source of truth; nothing else is carried.
 *
 * NOTE: Producers should enqueue with `singletonKey: <row.messageId>` to avoid
 * redundant probes on duplicates. Not required for correctness - `appendToMailbox`
 * dedups via SEARCH+FETCH.
 */
export interface AppendSentJobData {
  outboundMessageId: string;
}

/** Register the append-sent queue and handler. */
export async function registerAppendSent(boss: PgBoss): Promise<void> {
  await boss.createQueue("append-sent", {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // 120s matches imap-command. Retry after expiry is safe (dedup probe
    // short-circuits) - only wastes a round-trip. Bump if telemetry shows
    // the expire path firing on slow/heavy-Sent-folder accounts.
    expireInSeconds: 120,
  });

  // localConcurrency matches imap-command: up to 5 accounts can APPEND in parallel.
  // Per-account serialization of the probe+APPEND sequence is handled inside
  // appendToMailbox's `pending` map, so higher concurrency here only helps
  // multi-account throughput.
  await boss.work(
    "append-sent",
    { batchSize: 1, localConcurrency: 5 },
    async (jobs: Job<AppendSentJobData>[]): Promise<void> => {
      const job = jobs[0]!;
      try {
        await handleAppendSent(job.data);
      } catch (error) {
        // Deterministic IMAP failures won't change on retry; swallow so pg-boss
        // marks the job complete and the reaper cleans the row on its next
        // cycle. Mirrors the imap-command handler's contract.
        //
        // NOTE: This path is silent to the account owner - the Sent-folder
        // copy is simply missing. A future Outbox UI should stamp a dedicated
        // error column or terminal `append_failed` status here.
        if (error instanceof ImapPrimitiveNonRetriableError) {
          console.error(
            `[append-sent] row ${job.data.outboundMessageId} discarded (deterministic IMAP failure, non-retriable):`,
            error.message,
          );
          return;
        }
        // Single-line context before pg-boss logs the generic failure itself.
        console.error(`[append-sent] row ${job.data.outboundMessageId} failed:`, error);
        throw error;
      }
    },
  );
}

/**
 * Consume a `sent` row: APPEND its raw MIME to the account's Sent folder and
 * delete the row on success (or dedup hit). See the state-machine contract
 * in `packages/db/src/repositories/outbound-messages.ts`.
 */
async function handleAppendSent(data: AppendSentJobData): Promise<void> {
  const { outboundMessageId } = data;

  const row = await getOutboundMessageById(db, outboundMessageId);
  if (!row) {
    // Race with concurrent cleanup (reaper, manual SQL) - benign.
    console.warn(`[append-sent] row ${outboundMessageId} not found, skipping`);
    return;
  }

  if (row.status !== "sent") {
    // Defense-in-depth against out-of-band mutations (ops SQL, migrations).
    // The documented state machine has no transition out of `sent` except
    // deletion, so this branch is unreachable for rows produced through the
    // repository. Returning avoids double-appending if one ever appears.
    console.warn(
      `[append-sent] row ${outboundMessageId} in unexpected status "${row.status}", skipping`,
    );
    return;
  }

  const account = await getEmailAccountById(db, row.emailAccountId);
  if (!account) {
    // Cascade FK would normally clean outbound rows with the account - this is
    // a tiny window between detach and cascade running. Let it go; the row
    // will be gone on the next lookup anyway.
    console.warn(
      `[append-sent] account ${row.emailAccountId} not found for row ${outboundMessageId}, skipping`,
    );
    return;
  }

  const mailboxPath = await findMailboxPathByRole(db, row.emailAccountId, "sent");
  if (!mailboxPath) {
    // Discovery hasn't run or the provider has no Sent folder mapped.
    // Retrying won't conjure a mapping, and this row has no other consumer -
    // the reaper deletes it after the threshold without ever appending.
    // Escalate to error: the user-visible outcome is a missing Sent copy.
    console.error(
      `[append-sent] no Sent mailbox mapped for account ${row.emailAccountId}, leaving row ${outboundMessageId} for reaper`,
    );
    return;
  }

  const creds = resolveImapCredentials(account);
  const result = await appendToSentFolder({
    imapCache,
    emailAccountId: row.emailAccountId,
    imapCreds: creds,
    raw: row.rawMime,
    mailboxPath,
    messageId: row.messageId,
  });

  await deleteOutboundMessage(db, outboundMessageId);

  if (result.deduped) {
    console.log(
      `[append-sent] dedup hit for row ${outboundMessageId} (account ${row.emailAccountId}, uid ${result.uid}), row deleted`,
    );
  } else {
    console.log(
      `[append-sent] appended row ${outboundMessageId} to "${mailboxPath}" (account ${row.emailAccountId}, uid ${result.uid ?? "unknown"}), row deleted`,
    );
  }
}
