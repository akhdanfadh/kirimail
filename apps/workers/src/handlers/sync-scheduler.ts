import type { Job, PgBoss } from "pg-boss";

import { db, listAllEmailAccountIds } from "@kirimail/db";

/** Register the sync-scheduler queue, handler, and cron schedule. */
export async function registerSyncScheduler(boss: PgBoss, cronSchedule: string): Promise<void> {
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
