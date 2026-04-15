import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  cleanImapState,
  createEncryptedEmailAccount,
  createTestDb,
  createTestUser,
} from "#test/helpers";
import * as schema from "@kirimail/db/schema";
import { expungeMessages } from "@kirimail/mail";
import { seedMessage, testCredentials, withImapConnection } from "@kirimail/mail/testing";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registerSyncEmailAccount } from "../handlers";
import { IdlePool } from "../idle-pool";

type Db = NodePgDatabase<typeof schema>;

let db: Db;
let pool: Pool;
let userId: string;
let accountId: string;

const creds = () => testCredentials("idleuser");

beforeAll(() => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.delete(schema.messages);
  await db.delete(schema.mailboxes);
  await db.delete(schema.emailAccounts);
  await db.delete(schema.users);

  await cleanImapState(creds());

  userId = await createTestUser(db);
  accountId = await createEncryptedEmailAccount(db, userId, {
    emailUser: "idleuser",
  });
});

// ---------------------------------------------------------------------------
// pg-boss helper
// ---------------------------------------------------------------------------

function createTestBoss() {
  return new PgBoss({
    db: {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await pool.query(text, values);
        return { rows: result.rows };
      },
    },
    schema: "pgboss",
    __test__enableSpies: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idle pool", () => {
  it("IDLE event triggers a sync-email-account job", async () => {
    const boss = createTestBoss();
    await boss.start();

    try {
      await registerSyncEmailAccount(boss);
      const spy = boss.getSpy("sync-email-account");

      const idlePool = new IdlePool(boss);
      await idlePool.addAccount(accountId);
      expect(idlePool.size).toBe(1);

      try {
        // Seed a message - the IDLE connection should receive an EXISTS event.
        await seedMessage(creds(), { headers: { subject: "IDLE-Lifecycle" } });

        // Wait for the debounced sync job to be enqueued and complete.
        await spy.waitForJob(
          (data) => (data as { emailAccountId: string }).emailAccountId === accountId,
          "completed",
        );

        // Verify the sync handler persisted the seeded message.
        const [mbx] = await db
          .select({ id: schema.mailboxes.id })
          .from(schema.mailboxes)
          .where(
            and(eq(schema.mailboxes.emailAccountId, accountId), eq(schema.mailboxes.path, "INBOX")),
          );
        expect(mbx).toBeDefined();

        const msgs = await db
          .select({ subject: schema.messages.subject })
          .from(schema.messages)
          .where(eq(schema.messages.mailboxId, mbx!.id));
        expect(msgs).toEqual([expect.objectContaining({ subject: "IDLE-Lifecycle" })]);
      } finally {
        await idlePool.stopAll();
      }
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("EXPUNGE event triggers sync that removes message from DB", async () => {
    // Seed a message before starting IDLE so the mailbox has content.
    await seedMessage(creds(), { headers: { subject: "IDLE-Expunge" } });

    const boss = createTestBoss();
    await boss.start();

    try {
      await registerSyncEmailAccount(boss);
      const spy = boss.getSpy("sync-email-account");

      // Run an initial sync so the message exists in the DB.
      await boss.send(
        "sync-email-account",
        { emailAccountId: accountId },
        { singletonKey: accountId },
      );
      await spy.waitForJob(
        (data) => (data as { emailAccountId: string }).emailAccountId === accountId,
        "completed",
      );

      const [mbx] = await db
        .select({ id: schema.mailboxes.id })
        .from(schema.mailboxes)
        .where(
          and(eq(schema.mailboxes.emailAccountId, accountId), eq(schema.mailboxes.path, "INBOX")),
        );
      expect(mbx).toBeDefined();
      const before = await db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.mailboxId, mbx!.id));
      expect(before).toHaveLength(1);

      // Start IDLE, then delete the message via a separate connection.
      const idlePool = new IdlePool(boss);
      await idlePool.addAccount(accountId);

      try {
        const uid = await withImapConnection(creds(), async (client) => {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const uids = (await client.search({ all: true }, { uid: true })) || [];
            return uids[0]!;
          } finally {
            lock.release();
          }
        });
        await withImapConnection(creds(), (client) =>
          expungeMessages(client, { mailbox: "INBOX", uids: [uid] }),
        );

        // Wait for the EXPUNGE-triggered sync to remove the message from DB.
        await vi.waitFor(
          async () => {
            const remaining = await db
              .select({ id: schema.messages.id })
              .from(schema.messages)
              .where(eq(schema.messages.mailboxId, mbx!.id));
            expect(remaining).toHaveLength(0);
          },
          { timeout: 15_000, interval: 500 },
        );
      } finally {
        await idlePool.stopAll();
      }
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("debounce collapses rapid events into a single sync job", async () => {
    const boss = createTestBoss();
    await boss.start();

    try {
      await registerSyncEmailAccount(boss);
      const spy = boss.getSpy("sync-email-account");

      const idlePool = new IdlePool(boss);
      await idlePool.addAccount(accountId);

      try {
        // Seed 3 messages in rapid succession - each triggers an EXISTS
        // event, but the 1s debounce window should collapse them into a
        // single sync job that captures all messages.
        await seedMessage(creds(), { headers: { subject: "Burst-1" } });
        await seedMessage(creds(), { headers: { subject: "Burst-2" } });
        await seedMessage(creds(), { headers: { subject: "Burst-3" } });

        await spy.waitForJob(
          (data) => (data as { emailAccountId: string }).emailAccountId === accountId,
          "completed",
        );

        const [mbx] = await db
          .select({ id: schema.mailboxes.id })
          .from(schema.mailboxes)
          .where(
            and(eq(schema.mailboxes.emailAccountId, accountId), eq(schema.mailboxes.path, "INBOX")),
          );
        expect(mbx).toBeDefined();

        const msgs = await db
          .select({ subject: schema.messages.subject })
          .from(schema.messages)
          .where(eq(schema.messages.mailboxId, mbx!.id));
        expect(msgs).toHaveLength(3);
        expect(msgs.map((m) => m.subject).sort()).toEqual(["Burst-1", "Burst-2", "Burst-3"]);
      } finally {
        await idlePool.stopAll();
      }
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("removeAccount stops IDLE and allows re-adding", async () => {
    const boss = createTestBoss();
    await boss.start();

    try {
      await registerSyncEmailAccount(boss);

      const idlePool = new IdlePool(boss);
      await idlePool.addAccount(accountId);
      expect(idlePool.size).toBe(1);

      idlePool.removeAccount(accountId);
      expect(idlePool.size).toBe(0);

      // Re-adding after removal should work (removeCounter doesn't
      // permanently block the account).
      await idlePool.addAccount(accountId);
      expect(idlePool.size).toBe(1);

      await idlePool.stopAll();
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("startAll tolerates partial failures and stopAll cleans up", async () => {
    // Insert a second account with invalid IMAP credentials (bad host).
    // startAll should start the valid account and skip the bad one.
    const userId2 = await createTestUser(db);
    const badAccountId = await createEncryptedEmailAccount(db, userId2, {
      emailUser: "baduser",
    });
    // Point to a port that refuses connections immediately.
    await db
      .update(schema.emailAccounts)
      .set({ imapHost: "127.0.0.1", imapPort: 1 })
      .where(eq(schema.emailAccounts.id, badAccountId));

    const boss = createTestBoss();
    await boss.start();

    try {
      await registerSyncEmailAccount(boss);

      const idlePool = new IdlePool(boss);
      await idlePool.startAll();
      // Only the valid account should have started.
      expect(idlePool.size).toBe(1);

      await idlePool.stopAll();
      expect(idlePool.size).toBe(0);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("stopAll flushes pending debounce timers as sync jobs", async () => {
    const boss = createTestBoss();
    await boss.start();

    try {
      await registerSyncEmailAccount(boss);
      const spy = boss.getSpy("sync-email-account");

      const idlePool = new IdlePool(boss);
      await idlePool.addAccount(accountId);

      try {
        // Seed a message - EXISTS event starts the 1s debounce timer.
        await seedMessage(creds(), { headers: { subject: "Flush-Test" } });

        // Give the EXISTS event time to propagate over localhost before
        // stopping. Well within the 1s debounce window.
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        // stopAll flushes pending debounce timers as immediate sync jobs
        // before marking the pool as stopped.
        await idlePool.stopAll();
      }

      // The flushed job should still complete (boss is still running).
      await spy.waitForJob(
        (data) => (data as { emailAccountId: string }).emailAccountId === accountId,
        "completed",
      );

      // Verify the sync handler persisted the message despite early shutdown.
      const [mbx] = await db
        .select({ id: schema.mailboxes.id })
        .from(schema.mailboxes)
        .where(
          and(eq(schema.mailboxes.emailAccountId, accountId), eq(schema.mailboxes.path, "INBOX")),
        );
      expect(mbx).toBeDefined();

      const msgs = await db
        .select({ subject: schema.messages.subject })
        .from(schema.messages)
        .where(eq(schema.messages.mailboxId, mbx!.id));
      expect(msgs).toEqual([expect.objectContaining({ subject: "Flush-Test" })]);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
