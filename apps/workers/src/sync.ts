import type { SyncMailboxInput } from "@kirimail/mail";
import type { Job, PgBoss } from "pg-boss";

import {
  applyMailboxSync,
  listAllEmailAccountIds,
  db,
  getEmailAccountById,
  reconcileMailboxes,
} from "@kirimail/db";
import { discoverMailboxes, syncMailboxes } from "@kirimail/mail";

import { resolveImapCredentials } from "./credentials";

/** Register sync queues, handlers, and cron schedule. */
export async function registerSync(boss: PgBoss, cronSchedule: string): Promise<void> {
  // -- Setup for sync email account queue ------------------------------------

  await boss.createQueue("sync-email-account", {
    policy: "stately",
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // NOTE: 600s expireInSeconds may be tight for accounts with many large
    // mailboxes. Per-account timeout might be considered for later.
    expireInSeconds: 600,
  });

  // NOTE: boss.work's teamSize defaults to 1 here (one account syncs at a time).
  // Safe to increase since stately + singletonKey already prevents overlapping
  // syncs per account. Deferred until usage data shows this is a bottleneck.
  await boss.work(
    "sync-email-account",
    { batchSize: 1 },
    async (jobs: Job<{ emailAccountId: string }>[]): Promise<void> => {
      const job = jobs[0]!;
      const { emailAccountId } = job.data;
      console.log(`[sync-email-account] starting sync for account ${emailAccountId}`);

      try {
        await syncEmailAccount(emailAccountId);
      } catch (error) {
        // Log with account context before pg-boss captures the error for retry
        console.error(`[sync-email-account] account ${emailAccountId} failed:`, error);
        throw error;
      }
    },
  );

  // -- Setup for sync scheduler ----------------------------------------------

  await boss.createQueue("sync-scheduler", {
    policy: "stately",
    retryLimit: 1,
    expireInSeconds: 120,
  });

  await boss.work("sync-scheduler", { batchSize: 1 }, async (jobs: Job[]): Promise<void> => {
    const job = jobs[0]!;
    console.log(`[sync-scheduler] enqueuing sync jobs (trigger: ${job.id})`);

    // Enqueues a sync job per email account with singletonKey to prevent duplicates.
    // Per-send try/catch so one failed enqueue doesn't block remaining accounts.
    const emailAccountIds = await listAllEmailAccountIds(db);
    let enqueued = 0;
    for (const id of emailAccountIds) {
      try {
        await boss.send("sync-email-account", { emailAccountId: id }, { singletonKey: id });
        enqueued += 1;
      } catch (error) {
        console.error(`[sync-scheduler] failed to enqueue account ${id}:`, error);
      }
    }
    console.log(
      `[sync-scheduler] enqueued ${enqueued}/${emailAccountIds.length} sync-email-account job(s)`,
    );
  });

  await boss.schedule("sync-scheduler", cronSchedule);
}

/**
 * Sync a single email account: discover mailboxes, reconcile with DB,
 * fetch message headers over IMAP, and write results to the database.
 *
 * NOTE: Discovery and sync each open a separate IMAP connection. Sharing a
 * single connection would halve TLS+auth overhead, but requires changing the
 * packages/mail API to accept an external connection - deferred to keep the
 * adapter interface simple for now.
 */
export async function syncEmailAccount(accountId: string): Promise<void> {
  // 1. Fetch account with credentials
  const account = await getEmailAccountById(db, accountId);
  if (!account) {
    console.warn(`[sync-email-account] account ${accountId} not found, skipping`);
    return;
  }

  // 2. Decrypt IMAP credentials
  const creds = resolveImapCredentials(account);

  // 3. Discover mailboxes and reconcile with DB
  const { mailboxes } = await discoverMailboxes(creds);
  if (mailboxes.length === 0) {
    console.warn(
      `[sync-email-account] empty discovery for account ${accountId}, skipping reconciliation`,
    );
    return;
  }

  const { mailboxByPath, inserted, updated, removed } = await reconcileMailboxes(
    db,
    accountId,
    mailboxes,
  );
  if (inserted > 0 || updated > 0 || removed > 0) {
    console.log(
      `[sync-email-account] reconciled account ${accountId}: ` +
        `+${inserted} ~${updated} -${removed} mailbox(es)`,
    );
  }

  // 4. Build SyncMailboxInput[] from stored cursor state
  const syncInputs: SyncMailboxInput[] = [];
  for (const [path, { storedCursor }] of mailboxByPath) {
    syncInputs.push({ path, storedCursor });
  }

  if (syncInputs.length === 0) {
    console.log(`[sync-email-account] account ${accountId}: no mailboxes to sync`);
    return;
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
}
