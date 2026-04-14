import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  cleanImapState,
  createEncryptedEmailAccount,
  createTestDb,
  createTestUser,
} from "#test/helpers";
import * as schema from "@kirimail/db/schema";
import { withImapConnection, testCredentials, seedMessage } from "@kirimail/mail/testing";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerImapCommand } from "..";

type Db = NodePgDatabase<typeof schema>;

let db: Db;
let pool: Pool;
let userId: string;
let accountId: string;

const creds = () => testCredentials("imapcommanduser");

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
  accountId = await createEncryptedEmailAccount(db, userId, {
    emailUser: "imapcommanduser",
  });
});

// ---------------------------------------------------------------------------
// IMAP read-back helpers
// ---------------------------------------------------------------------------

/** Fetch flags for a single UID in a mailbox via IMAP read-back. */
async function fetchFlags(mailbox: string, uid: number): Promise<Set<string>> {
  return withImapConnection(creds(), async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { flags: true }, { uid: true });
      if (!msg) throw new Error(`UID ${uid} not found`);
      return msg.flags ?? new Set();
    } finally {
      lock.release();
    }
  });
}

/** Get all UIDs in a mailbox via SEARCH ALL. */
async function getUids(mailbox: string): Promise<number[]> {
  return withImapConnection(creds(), async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return (await client.search({ all: true }, { uid: true })) || [];
    } finally {
      lock.release();
    }
  });
}

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

describe("imap-command via pg-boss", () => {
  it("store-flags adds \\Seen to a message", async () => {
    await seedMessage(creds(), { headers: { subject: "Flag-Me" } });
    const [uid] = await getUids("INBOX");

    const boss = createTestBoss();
    await boss.start();

    try {
      await registerImapCommand(boss);
      const spy = boss.getSpy("imap-command");

      await boss.send("imap-command", {
        type: "store-flags",
        emailAccountId: accountId,
        mailbox: "INBOX",
        uids: [uid!],
        flags: ["\\Seen"],
        operation: "add",
      });

      await spy.waitForJob(
        (data) => (data as { type: string }).type === "store-flags",
        "completed",
      );

      const flags = await fetchFlags("INBOX", uid!);
      expect(flags.has("\\Seen")).toBe(true);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("move relocates a message from INBOX to destination", async () => {
    await seedMessage(creds(), { headers: { subject: "Move-Me" } });
    const [uid] = await getUids("INBOX");

    // Create destination mailbox
    await withImapConnection(creds(), (client) => client.mailboxCreate("MoveTarget"));

    const boss = createTestBoss();
    await boss.start();

    try {
      await registerImapCommand(boss);
      const spy = boss.getSpy("imap-command");

      await boss.send("imap-command", {
        type: "move",
        emailAccountId: accountId,
        mailbox: "INBOX",
        destination: "MoveTarget",
        uids: [uid!],
      });

      await spy.waitForJob((data) => (data as { type: string }).type === "move", "completed");

      const inboxUids = await getUids("INBOX");
      expect(inboxUids).toHaveLength(0);

      const destUids = await getUids("MoveTarget");
      expect(destUids).toHaveLength(1);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("expunge permanently removes a message", async () => {
    await seedMessage(creds(), { headers: { subject: "Keep" } });
    await seedMessage(creds(), { headers: { subject: "Delete-Me" } });

    const uidsBefore = await getUids("INBOX");
    expect(uidsBefore).toHaveLength(2);
    const uidToDelete = uidsBefore[1]!;
    const uidToKeep = uidsBefore[0]!;

    const boss = createTestBoss();
    await boss.start();

    try {
      await registerImapCommand(boss);
      const spy = boss.getSpy("imap-command");

      await boss.send("imap-command", {
        type: "expunge",
        emailAccountId: accountId,
        mailbox: "INBOX",
        uids: [uidToDelete],
      });

      await spy.waitForJob((data) => (data as { type: string }).type === "expunge", "completed");

      const uidsAfter = await getUids("INBOX");
      expect(uidsAfter).toHaveLength(1);
      expect(uidsAfter[0]).toBe(uidToKeep);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("completes gracefully when account does not exist", async () => {
    const boss = createTestBoss();
    await boss.start();

    try {
      await registerImapCommand(boss);
      const spy = boss.getSpy("imap-command");

      await boss.send("imap-command", {
        type: "store-flags",
        emailAccountId: randomUUID(),
        mailbox: "INBOX",
        uids: [1],
        flags: ["\\Seen"],
        operation: "add",
      });

      // Job should complete (not fail) because the handler returns early
      await spy.waitForJob(() => true, "completed");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
