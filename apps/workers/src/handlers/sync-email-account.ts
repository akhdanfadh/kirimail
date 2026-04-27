import type { SyncMailboxInput } from "@kirimail/mail";
import type { Job, PgBoss } from "pg-boss";

import { applyMailboxSync, db, getEmailAccountById, reconcileMailboxes } from "@kirimail/db";
import { discoverMailboxes, syncMailboxes } from "@kirimail/mail";

import { resolveImapCredentials } from "../credentials";
import { EVENT_DISPATCHER_QUEUE } from "./event-dispatcher";

/** Register the sync-email-account queue and handler. */
export async function registerSyncEmailAccount(boss: PgBoss): Promise<void> {
  await boss.createQueue("sync-email-account", {
    policy: "stately",
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // NOTE: 600s expireInSeconds may be tight for accounts with many large
    // mailboxes. Per-account timeout might be considered for later.
    expireInSeconds: 600,
  });

  // NOTE: localConcurrency: 3 lets multiple accounts sync in parallel.
  // stately + singletonKey already prevents overlapping syncs per account,
  // so this only parallelizes across accounts. Kept modest (not 5+) because
  // each sync opens its own IMAP connection and does bulk DB writes -
  // higher values pressure both the mail server and Postgres.
  await boss.work(
    "sync-email-account",
    { batchSize: 1, localConcurrency: 3 },
    async (jobs: Job<{ emailAccountId: string }>[]): Promise<void> => {
      const job = jobs[0]!;
      const { emailAccountId } = job.data;
      console.log(`[sync-email-account] starting sync for account ${emailAccountId}`);

      let eventsEmitted = 0;
      try {
        eventsEmitted = await syncEmailAccount(emailAccountId);
      } catch (err) {
        // Log with account context before pg-boss captures the error for retry
        console.error(`[sync-email-account] account ${emailAccountId} failed:`, err);
        throw err;
      }

      if (eventsEmitted > 0) {
        // Trigger immediate indexing for search, only when the sync wrote new events.
        // The dispatcher queue's `stately` policy collapses overlapping triggers into
        // one tick; the 5-min cron picks up any unconsumed events when this push gets lost
        // or a tick failed. Enqueue failure is logged, not rethrown - sync already committed.
        try {
          await boss.send(EVENT_DISPATCHER_QUEUE, {});
        } catch (err) {
          console.error(
            `[sync-email-account] failed to enqueue ${EVENT_DISPATCHER_QUEUE} (account ${emailAccountId})`,
            err,
          );
        }
      }
    },
  );
}

/**
 * Sync a single email account: discover mailboxes, reconcile with DB,
 * fetch message headers over IMAP, and write results to the database.
 *
 * Returns the total number of `domain_events` rows emitted by this sync,
 * across both producer paths: one per inserted message + one per deleted
 * message, plus one per removed mailbox. The caller uses this count as a
 * gate to decide whether to wake the dispatcher post-sync.
 */
// NOTE: Discovery and sync each open a separate IMAP connection. Sharing a
// single connection would halve TLS+auth overhead, but requires changing the
// packages/mail API to accept an external connection - deferred to keep the
// adapter interface simple for now.
export async function syncEmailAccount(accountId: string): Promise<number> {
  // 1. Fetch account with credentials
  const account = await getEmailAccountById(db, accountId);
  if (!account) {
    console.warn(`[sync-email-account] account ${accountId} not found, skipping`);
    return 0;
  }

  // 2. Decrypt IMAP credentials
  const creds = resolveImapCredentials(account);

  // 3. Discover mailboxes and reconcile with DB
  const { mailboxes } = await discoverMailboxes(creds);
  if (mailboxes.length === 0) {
    console.warn(
      `[sync-email-account] empty discovery for account ${accountId}, skipping reconciliation`,
    );
    return 0;
  }

  const { mailboxByPath, inserted, updated, removed, messagesDeleted } = await reconcileMailboxes(
    db,
    accountId,
    mailboxes,
  );
  if (inserted > 0 || updated > 0 || removed > 0) {
    console.log(
      `[sync-email-account] reconciled account ${accountId}: ` +
        `+${inserted} ~${updated} -${removed} mailbox(es)` +
        (messagesDeleted > 0 ? `, -${messagesDeleted} message(s) from removed mailbox(es)` : ""),
    );
  }

  // 4. Build SyncMailboxInput[] from stored cursor state
  const syncInputs: SyncMailboxInput[] = [];
  for (const [path, { storedCursor }] of mailboxByPath) {
    syncInputs.push({ path, storedCursor });
  }

  if (syncInputs.length === 0) {
    console.log(`[sync-email-account] account ${accountId}: no mailboxes to sync`);
    return 0;
  }

  // 5. Sync all mailboxes over a single IMAP connection
  const { errors: imapErrors, results } = await syncMailboxes(creds, syncInputs);

  // 6. Write sync results to DB per mailbox
  let totalCreated = 0;
  let totalDeleted = 0;
  let dbErrors = 0;

  for (const [path, result] of results) {
    const mbx = mailboxByPath.get(path);
    if (!mbx) continue;

    // Each mailbox is written to DB independently so a failure on one doesn't
    // lose already-completed IMAP work. applyMailboxSync uses onConflictDoNothing,
    // so retries are idempotent.
    try {
      // Determine old uidValidity for purge logic
      const oldUidValidity =
        result.action.type === "full-resync" && result.action.reason === "uid-validity-changed"
          ? (mbx.storedCursor?.uidValidity ?? null)
          : null;

      const { messagesCreated, messagesDeleted } = await applyMailboxSync(
        db,
        mbx.id,
        result.messages,
        result.cursor,
        result.remoteUids,
        oldUidValidity,
      );
      totalCreated += messagesCreated;
      totalDeleted += messagesDeleted;
    } catch (error) {
      dbErrors += 1;
      console.error(`[sync-email-account] db write "${path}" failed:`, error);
    }
  }

  for (const [path, error] of imapErrors) {
    console.error(`[sync-email-account] imap fetch "${path}" failed:`, error.message);
  }

  // Mailboxes in neither results nor imapErrors were skipped (e.g., connection
  // dropped mid-sync before syncMailboxes could attempt them).
  const skipped = syncInputs.length - results.size - imapErrors.size;

  console.log(
    `[sync-email-account] account ${accountId}: ` +
      `${results.size} synced, ${imapErrors.size} imap errors, ${dbErrors} db errors` +
      `${skipped > 0 ? `, ${skipped} skipped` : ""}, ` +
      `+${totalCreated} -${totalDeleted} messages`,
  );

  return totalCreated + totalDeleted + removed;
}
