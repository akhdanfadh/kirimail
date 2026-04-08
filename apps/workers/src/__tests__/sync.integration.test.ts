import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as schema from "@kirimail/db/schema";
import { withImapConnection, testCredentials, seedMessage } from "@kirimail/mail/testing";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerSync, syncEmailAccount } from "../sync";
import {
  cleanImapState,
  createEncryptedEmailAccount,
  createTestDb,
  createTestUser,
} from "./helpers";

type Db = NodePgDatabase<typeof schema>;

let db: Db;
let pool: Pool;
let userId: string;
let accountId: string;

const creds = () => testCredentials("syncuser");

beforeAll(() => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Clean DB state (reverse FK order, then users)
  await db.delete(schema.messages);
  await db.delete(schema.mailboxes);
  await db.delete(schema.emailAccounts);
  await db.delete(schema.users);

  // Clean IMAP state
  await cleanImapState(creds());

  // Scaffold fresh test data
  userId = await createTestUser(db);
  accountId = await createEncryptedEmailAccount(db, userId);
});

/** Helper: find the INBOX mailbox row for the current test account. */
async function findInbox() {
  const rows = await db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.emailAccountId, accountId));
  return rows.find((m) => m.role === "inbox")!;
}

/** Helper: query all message rows for a given mailbox ID. */
async function messagesFor(mailboxId: string) {
  return db.select().from(schema.messages).where(eq(schema.messages.mailboxId, mailboxId));
}

// ---------------------------------------------------------------------------
// Direct syncEmailAccount tests
// ---------------------------------------------------------------------------

describe("syncEmailAccount", () => {
  it("syncs headers from IMAP into DB", async () => {
    await seedMessage(creds(), { headers: { subject: "Msg-A" } });
    await seedMessage(creds(), { headers: { subject: "Msg-B" } });
    await seedMessage(creds(), { headers: { subject: "Msg-C" } });

    await syncEmailAccount(accountId);

    const inbox = await findInbox();
    expect(inbox).toBeDefined();
    expect(inbox.uidValidity).toBeGreaterThan(0);
    expect(inbox.uidNext).toBeGreaterThan(0);

    const msgRows = await messagesFor(inbox.id);
    expect(msgRows).toHaveLength(3);
    expect(msgRows.map((m) => m.subject).sort()).toEqual(["Msg-A", "Msg-B", "Msg-C"]);

    for (const msg of msgRows) {
      expect(msg.providerUid).toBeGreaterThan(0);
      expect(msg.uidValidity).toBe(inbox.uidValidity);
      expect(msg.internalDate).toBeInstanceOf(Date);
      expect(msg.sizeOctets).toBeGreaterThan(0);
    }
  });

  it("is idempotent on re-run", async () => {
    await seedMessage(creds(), { headers: { subject: "Idempotent" } });

    await syncEmailAccount(accountId);

    const inbox = await findInbox();
    const firstRun = await messagesFor(inbox.id);
    expect(firstRun).toHaveLength(1);
    const firstIds = firstRun.map((m) => m.id).sort();

    // Re-run with no IMAP changes
    await syncEmailAccount(accountId);

    const secondRun = await messagesFor(inbox.id);
    expect(secondRun).toHaveLength(1);
    expect(secondRun.map((m) => m.id).sort()).toEqual(firstIds);
  });

  it("adds new messages incrementally without re-inserting existing ones", async () => {
    await seedMessage(creds(), { headers: { subject: "First" } });
    await seedMessage(creds(), { headers: { subject: "Second" } });

    await syncEmailAccount(accountId);

    const inbox = await findInbox();
    const afterFirst = await messagesFor(inbox.id);
    expect(afterFirst).toHaveLength(2);
    const originalIds = afterFirst.map((m) => m.id).sort();

    // Add one more message, re-sync
    await seedMessage(creds(), { headers: { subject: "Third" } });
    await syncEmailAccount(accountId);

    const afterSecond = await messagesFor(inbox.id);
    expect(afterSecond).toHaveLength(3);
    expect(afterSecond.map((m) => m.subject).sort()).toEqual(["First", "Second", "Third"]);

    // Original rows preserved (not deleted and reinserted)
    const preservedIds = afterSecond
      .filter((m) => m.subject !== "Third")
      .map((m) => m.id)
      .sort();
    expect(preservedIds).toEqual(originalIds);
  });

  it("removes messages deleted on the IMAP server", async () => {
    await seedMessage(creds(), { headers: { subject: "Keep" } });
    await seedMessage(creds(), { headers: { subject: "Delete-Me" } });
    await seedMessage(creds(), { headers: { subject: "Also-Keep" } });

    await syncEmailAccount(accountId);

    const inbox = await findInbox();
    expect(await messagesFor(inbox.id)).toHaveLength(3);

    // Delete one message on the IMAP server
    await withImapConnection(creds(), async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        // messageDelete accepts a search query directly
        await client.messageDelete({ subject: "Delete-Me" });
      } finally {
        lock.release();
      }
    });

    await syncEmailAccount(accountId);

    const remaining = await messagesFor(inbox.id);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((m) => m.subject).sort()).toEqual(["Also-Keep", "Keep"]);
  });

  it("reconciles removed mailboxes", async () => {
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate("TestFolder");
    });
    await seedMessage(creds(), { headers: { subject: "In TestFolder" }, mailbox: "TestFolder" });
    await seedMessage(creds(), { headers: { subject: "In INBOX" } });

    await syncEmailAccount(accountId);

    // Verify both mailboxes exist
    const mbxBefore = await db
      .select()
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.emailAccountId, accountId));
    const testFolder = mbxBefore.find((m) => m.path === "TestFolder");
    expect(testFolder).toBeDefined();
    expect(await messagesFor(testFolder!.id)).toHaveLength(1);

    // Delete TestFolder on the IMAP server
    await withImapConnection(creds(), async (client) => {
      await client.mailboxDelete("TestFolder");
    });

    // Re-sync - TestFolder should be reconciled away
    await syncEmailAccount(accountId);

    const mbxAfter = await db
      .select()
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.emailAccountId, accountId));
    expect(mbxAfter.find((m) => m.path === "TestFolder")).toBeUndefined();

    // Messages cascade-deleted
    expect(await messagesFor(testFolder!.id)).toHaveLength(0);

    // INBOX still intact
    expect(mbxAfter.find((m) => m.role === "inbox")).toBeDefined();
  });

  it("purges stale messages when UID validity changes", async () => {
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate("Volatile");
    });
    await seedMessage(creds(), { headers: { subject: "Old-A" }, mailbox: "Volatile" });
    await seedMessage(creds(), { headers: { subject: "Old-B" }, mailbox: "Volatile" });

    await syncEmailAccount(accountId);

    const mbxBefore = (
      await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.emailAccountId, accountId))
    ).find((m) => m.path === "Volatile")!;
    expect(await messagesFor(mbxBefore.id)).toHaveLength(2);
    const oldUidValidity = mbxBefore.uidValidity;

    // Delete and recreate - forces new UID validity
    await withImapConnection(creds(), async (client) => {
      await client.mailboxDelete("Volatile");
      await client.mailboxCreate("Volatile");
    });
    await seedMessage(creds(), { headers: { subject: "New-X" }, mailbox: "Volatile" });

    await syncEmailAccount(accountId);

    const mbxAfter = (
      await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.emailAccountId, accountId))
    ).find((m) => m.path === "Volatile")!;

    expect(mbxAfter.uidValidity).not.toBe(oldUidValidity);

    // Old messages purged, only new message remains
    const msgsAfter = await messagesFor(mbxAfter.id);
    expect(msgsAfter).toHaveLength(1);
    expect(msgsAfter[0]!.subject).toBe("New-X");
  });

  it("skips gracefully when account is deleted before sync runs", async () => {
    await seedMessage(creds(), { headers: { subject: "Orphan" } });

    // Delete the account before sync runs
    await db.delete(schema.emailAccounts).where(eq(schema.emailAccounts.id, accountId));

    // Should not throw
    await syncEmailAccount(accountId);

    // No mailboxes or messages created
    const mbxRows = await db
      .select()
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.emailAccountId, accountId));
    expect(mbxRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end via pg-boss
// ---------------------------------------------------------------------------

describe("end-to-end via pg-boss", () => {
  /** Create a pg-boss instance with spies enabled for testing. */
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

  it("sync-email-account job syncs headers into DB", async () => {
    await seedMessage(creds(), { headers: { subject: "PgBoss-A" } });
    await seedMessage(creds(), { headers: { subject: "PgBoss-B" } });

    const boss = createTestBoss();
    await boss.start();

    try {
      await registerSync(boss, "59 23 31 12 *");

      const spy = boss.getSpy("sync-email-account");

      await boss.send(
        "sync-email-account",
        { emailAccountId: accountId },
        { singletonKey: accountId },
      );

      await spy.waitForJob(
        (data) => (data as { emailAccountId: string }).emailAccountId === accountId,
        "completed",
      );

      const inbox = await findInbox();
      expect(inbox).toBeDefined();

      const msgRows = await messagesFor(inbox.id);
      expect(msgRows).toHaveLength(2);
      expect(msgRows.map((m) => m.subject).sort()).toEqual(["PgBoss-A", "PgBoss-B"]);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("sync-scheduler enqueues per-account jobs that complete", async () => {
    // Create a second account so the scheduler has multiple to enqueue
    const userId2 = await createTestUser(db);
    const accountId2 = await createEncryptedEmailAccount(db, userId2);

    await seedMessage(creds(), { headers: { subject: "Sched-Msg" } });

    const boss = createTestBoss();
    await boss.start();

    try {
      await registerSync(boss, "59 23 31 12 *");

      const syncSpy = boss.getSpy("sync-email-account");
      const schedulerSpy = boss.getSpy("sync-scheduler");

      // Manually trigger the scheduler (instead of waiting for cron)
      await boss.send("sync-scheduler", {});

      // Wait for the scheduler job itself to complete
      await schedulerSpy.waitForJob(() => true, "completed");

      // Wait for both sync-email-account jobs to complete
      await syncSpy.waitForJob(
        (data) => (data as { emailAccountId: string }).emailAccountId === accountId,
        "completed",
      );
      await syncSpy.waitForJob(
        (data) => (data as { emailAccountId: string }).emailAccountId === accountId2,
        "completed",
      );

      // Verify the first account synced messages
      const inbox = await findInbox();
      expect(inbox).toBeDefined();
      const msgRows = await messagesFor(inbox.id);
      expect(msgRows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

describe("worker lifecycle", () => {
  it("startWorkers boots and stops cleanly", async () => {
    const savedCron = process.env.SYNC_CRON_SCHEDULE;
    process.env.SYNC_CRON_SCHEDULE = "59 23 31 12 *";

    try {
      const { startWorkers } = await import("../index");
      const handle = await startWorkers();

      expect(handle).toBeDefined();
      await handle.stop();
    } finally {
      if (savedCron !== undefined) {
        process.env.SYNC_CRON_SCHEDULE = savedCron;
      } else {
        delete process.env.SYNC_CRON_SCHEDULE;
      }
    }
  });
});
