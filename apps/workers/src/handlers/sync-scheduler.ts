import type { Job, PgBoss } from "pg-boss";

import { db, listAllEmailAccountIds } from "@kirimail/db";

import { SYNC_EMAIL_ACCOUNT_QUEUE } from "./sync-email-account";

export const SYNC_SCHEDULER_QUEUE = "sync-scheduler";

/** Register the sync-scheduler queue, handler, and cron schedule. */
export async function registerSyncScheduler(boss: PgBoss, cronSchedule: string): Promise<void> {
  await boss.createQueue(SYNC_SCHEDULER_QUEUE, {
    policy: "stately",
    retryLimit: 1,
    expireInSeconds: 120,
  });

  await boss.work(SYNC_SCHEDULER_QUEUE, { batchSize: 1 }, async (jobs: Job[]): Promise<void> => {
    const job = jobs[0]!;
    console.log(`[${SYNC_SCHEDULER_QUEUE}] enqueuing sync jobs (trigger: ${job.id})`);

    // Enqueues a sync job per email account with singletonKey to prevent duplicates.
    // Per-send try/catch so one failed enqueue doesn't block remaining accounts.
    const emailAccountIds = await listAllEmailAccountIds(db);
    let enqueued = 0;
    for (const id of emailAccountIds) {
      try {
        await boss.send(SYNC_EMAIL_ACCOUNT_QUEUE, { emailAccountId: id }, { singletonKey: id });
        enqueued += 1;
      } catch (error) {
        console.error(`[${SYNC_SCHEDULER_QUEUE}] failed to enqueue account ${id}:`, error);
      }
    }
    console.log(
      `[${SYNC_SCHEDULER_QUEUE}] enqueued ${enqueued}/${emailAccountIds.length} ${SYNC_EMAIL_ACCOUNT_QUEUE} job(s)`,
    );
  });

  await boss.schedule(SYNC_SCHEDULER_QUEUE, cronSchedule);
}
