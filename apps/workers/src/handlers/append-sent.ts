import type { AppendToMailboxResult } from "@kirimail/mail";
import type { Job, PgBoss } from "pg-boss";

import {
  db,
  deleteOutboundMessage,
  findMailboxPathByRole,
  getEmailAccountById,
  getOutboundMessageById,
} from "@kirimail/db";
import { appendToSentFolder, asNonRetriableImapError, ImapNonRetriableError } from "@kirimail/mail";

import { imapCache } from "../caches";
import { resolveImapCredentials } from "../credentials";

export const APPEND_SENT_QUEUE = "append-sent";

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
  await boss.createQueue(APPEND_SENT_QUEUE, {
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
    APPEND_SENT_QUEUE,
    { batchSize: 1, localConcurrency: 5 },
    async (jobs: Job<AppendSentJobData>[]): Promise<void> => {
      const job = jobs[0]!;
      try {
        await handleAppendSent(job.data);
      } catch (err) {
        // Deterministic IMAP failures (rotated credentials, missing Sent mailbox,
        // server precondition) won't change on retry; swallow so pg-boss marks the
        // job complete and the reaper cleans the row on its next cycle.
        //
        // NOTE: This is NOT pg-boss dead-lettering - returning here marks the job successful,
        // so it leaves no DLQ entry and no failure metric. If a real DLQ is wired up later,
        // throw a typed error pg-boss can route there instead.
        //
        // NOTE: This path is silent to the account owner - the Sent-folder
        // copy is simply missing. A future Outbox UI should stamp a dedicated
        // error column or terminal `append_failed` status here.
        if (err instanceof ImapNonRetriableError) {
          console.error(
            `[${APPEND_SENT_QUEUE}] row ${job.data.outboundMessageId} discarded (deterministic IMAP failure, non-retriable):`,
            err,
          );
          return;
        }
        console.error(`[${APPEND_SENT_QUEUE}] row ${job.data.outboundMessageId} failed:`, err);
        throw err;
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
    console.warn(`[${APPEND_SENT_QUEUE}] row ${outboundMessageId} not found, skipping`);
    return;
  }

  if (row.status !== "sent") {
    // Defense-in-depth against out-of-band mutations (ops SQL, migrations).
    // The documented state machine has no transition out of `sent` except
    // deletion, so this branch is unreachable for rows produced through the
    // repository. Returning avoids double-appending if one ever appears.
    console.warn(
      `[${APPEND_SENT_QUEUE}] row ${outboundMessageId} in unexpected status "${row.status}", skipping`,
    );
    return;
  }

  const account = await getEmailAccountById(db, row.emailAccountId);
  if (!account) {
    // Cascade FK would normally clean outbound rows with the account - this is
    // a tiny window between detach and cascade running. Let it go; the row
    // will be gone on the next lookup anyway.
    console.warn(
      `[${APPEND_SENT_QUEUE}] account ${row.emailAccountId} not found for row ${outboundMessageId}, skipping`,
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
      `[${APPEND_SENT_QUEUE}] no Sent mailbox mapped for account ${row.emailAccountId}, leaving row ${outboundMessageId} for reaper`,
    );
    return;
  }

  const creds = resolveImapCredentials(account);
  let result: AppendToMailboxResult;
  try {
    result = await appendToSentFolder({
      imapCache,
      emailAccountId: row.emailAccountId,
      imapCreds: creds,
      raw: row.rawMime,
      mailboxPath,
      messageId: row.messageId,
    });
  } catch (err) {
    // Wrap spans both connect-phase (auth from getOrConnect, before appendToSentFolder runs)
    // and command-phase (NO/BAD from STATUS/SELECT/APPEND inside the helper) so both
    // deterministic shapes route to the typed non-retriable. Non-deterministic errors
    // fall through via `?? err` and bubble for retry.
    throw (
      asNonRetriableImapError(
        err,
        `IMAP append-sent failed deterministically (account: ${row.emailAccountId}, row: ${outboundMessageId}, mailbox: ${JSON.stringify(mailboxPath)})`,
      ) ?? err
    );
  }

  await deleteOutboundMessage(db, outboundMessageId);

  if (result.deduped) {
    console.log(
      `[${APPEND_SENT_QUEUE}] dedup hit for row ${outboundMessageId} (account ${row.emailAccountId}, uid ${result.uid}), row deleted`,
    );
  } else {
    console.log(
      `[${APPEND_SENT_QUEUE}] appended row ${outboundMessageId} to "${mailboxPath}" (account ${row.emailAccountId}, uid ${result.uid ?? "unknown"}), row deleted`,
    );
  }
}
