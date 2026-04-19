import type { Job, PgBoss } from "pg-boss";

import { db, reapStaleSentOutboundMessages } from "@kirimail/db";

/**
 * Age threshold for a `sent` outbound_messages row to be considered abandoned.
 *
 * A healthy APPEND completes in seconds; pg-boss retries extend that by at
 * most a few minutes. Six hours is deliberately generous headroom for
 * pathologically slow IMAP servers plus retry sequences, without leaving
 * genuinely stuck rows to pile up beyond a working day.
 */
export const SENT_ROW_REAPER_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** How often the reaper runs. Standard cron expression consumed by pg-boss. */
const REAPER_CRON_SCHEDULE = "*/15 * * * *";

/** Register the outbound-reaper queue, handler, and cron schedule. */
export async function registerOutboundReaper(boss: PgBoss): Promise<void> {
  await boss.createQueue("outbound-reaper", {
    policy: "stately",
    // retryLimit: 0 - the 15-min cron is a more reliable retry than pg-boss's backoff,
    // and the reap DELETE is idempotent across runs (a second pass on the same rows
    // returns empty). Retrying would add log noise without adding reliability.
    retryLimit: 0,
    expireInSeconds: 120,
  });

  await boss.work("outbound-reaper", { batchSize: 1 }, async (jobs: Job[]): Promise<void> => {
    const job = jobs[0]!;
    console.log(`[outbound-reaper] running (trigger: ${job.id})`);
    try {
      await reapStaleSentRows();
    } catch (err) {
      // retryLimit: 0 means pg-boss drops the job on failure; make sure at least
      // one error line with context lands in operator logs before the rethrow.
      console.error("[outbound-reaper] sweep failed:", err);
      throw err;
    }
  });

  await boss.schedule("outbound-reaper", REAPER_CRON_SCHEDULE);
}

/**
 * Delete abandoned `sent` outbound_messages rows and log one line per row.
 *
 * Rows reach this state when the append-sent handler cannot reach
 * `deleteOutboundMessage`:
 * - transient IMAP errors burned pg-boss's retry budget
 * - a non-retriable error short-circuited the handler (e.g. malformed Message-ID)
 * - the Sent mailbox was not mapped when the handler ran (discovery pending)
 *
 * NOTE: DELETE is unbounded. If backlogs ever reach thousands, add `LIMIT N`
 * to the repository helper and let the cron drain in batches.
 */
export async function reapStaleSentRows(): Promise<void> {
  const now = Date.now();
  const olderThan = new Date(now - SENT_ROW_REAPER_THRESHOLD_MS);
  const reaped = await reapStaleSentOutboundMessages(db, olderThan);

  for (const row of reaped) {
    // sent_at is NOT NULL for any status='sent' row
    // (outbound_messages_sent_at_matches_status_chk), so the non-null assertion is safe.
    const ageMs = now - row.sentAt!.getTime();
    console.warn(
      `[outbound-reaper] reaped abandoned sent row ${row.id} ` +
        `(account ${row.emailAccountId}, messageId ${row.messageId}, age ${ageMs}ms)`,
    );
  }

  // Trailing confirmation so quiet (zero-row) runs still show the DELETE completed.
  console.log(`[outbound-reaper] sweep complete, reaped ${reaped.length} row(s)`);
}
