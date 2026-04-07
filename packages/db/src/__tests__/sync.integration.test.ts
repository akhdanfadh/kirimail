import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as schema from "../schema";

import { mailboxes, messages } from "../schema";
import { applySync } from "../sync";
import {
  buildFetchedMessage,
  createTestDb,
  createTestEmailAccount,
  createTestMailbox,
  createTestUser,
} from "./helpers";

type Db = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let db: Db;
let pool: Pool;

// Per-test scaffold: a user with one account and one mailbox
let userId: string;
let accountId: string;
let mailboxId: string;

beforeAll(() => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.delete(messages);
  await db.delete(mailboxes);

  userId = await createTestUser(db);
  accountId = await createTestEmailAccount(db, userId);
  mailboxId = await createTestMailbox(db, accountId);
});

const baseCursor = {
  uidValidity: 1,
  uidNext: 100,
  messageCount: 3,
  highestModseq: 50,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applySync", () => {
  it("inserts messages and updates the mailbox cursor", async () => {
    const synced = [
      buildFetchedMessage({ uid: 1, subject: "First", flags: new Set(["\\Seen"]) }),
      buildFetchedMessage({ uid: 2, subject: "Second", messageId: null }),
      buildFetchedMessage({ uid: 3, subject: "Third", flags: new Set(["\\Seen", "\\Flagged"]) }),
    ];
    const cursor = { ...baseCursor, messageCount: 3, uidNext: 4 };

    const result = await applySync(db, mailboxId, synced, cursor, null, null);

    expect(result.messagesCreated).toBe(3);
    expect(result.messagesDeleted).toBe(0);

    // Messages stored with correct data
    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.subject).sort()).toEqual(["First", "Second", "Third"]);

    // IMAP metadata preserved
    for (const row of rows) {
      expect(row.uidValidity).toBe(cursor.uidValidity);
      expect(row.sizeOctets).toBeGreaterThan(0);
      expect(row.internalDate).toBeInstanceOf(Date);
    }

    // Null headerMessageId stored without error
    const nullIdRow = rows.find((r) => r.subject === "Second");
    expect(nullIdRow!.headerMessageId).toBeNull();

    // Flags converted from Set to array
    const flaggedRow = rows.find((r) => r.subject === "Third");
    expect(flaggedRow!.flags).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged"]));

    // Cursor updated on mailbox
    const [mbx] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mbx!.uidValidity).toBe(cursor.uidValidity);
    expect(mbx!.uidNext).toBe(cursor.uidNext);
    expect(mbx!.messageCount).toBe(cursor.messageCount);
    expect(mbx!.highestModseq).toBe(cursor.highestModseq);
  });

  it("is idempotent when re-applied with the same data", async () => {
    const synced = [buildFetchedMessage({ uid: 1 }), buildFetchedMessage({ uid: 2 })];
    const cursor = { ...baseCursor, uidNext: 3, messageCount: 2 };

    const first = await applySync(db, mailboxId, synced, cursor, null, null);
    expect(first.messagesCreated).toBe(2);

    const second = await applySync(db, mailboxId, synced, cursor, null, null);
    expect(second.messagesCreated).toBe(0);

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(2);
  });

  it("updates cursor even with empty message array", async () => {
    const cursor = { uidValidity: 42, uidNext: 100, messageCount: 0, highestModseq: null };

    const result = await applySync(db, mailboxId, [], cursor, null, null);

    expect(result.messagesCreated).toBe(0);
    expect(result.messagesDeleted).toBe(0);

    const [mbx] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mbx!.uidValidity).toBe(42);
    expect(mbx!.uidNext).toBe(100);
    expect(mbx!.messageCount).toBe(0);
    expect(mbx!.highestModseq).toBeNull();
  });

  it("appends new messages on incremental sync", async () => {
    // Initial sync: 3 messages
    const initial = [
      buildFetchedMessage({ uid: 1, subject: "Old 1" }),
      buildFetchedMessage({ uid: 2, subject: "Old 2" }),
      buildFetchedMessage({ uid: 3, subject: "Old 3" }),
    ];
    await applySync(
      db,
      mailboxId,
      initial,
      { ...baseCursor, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    // Incremental sync: 2 new messages
    const incremental = [
      buildFetchedMessage({ uid: 4, subject: "New 1" }),
      buildFetchedMessage({ uid: 5, subject: "New 2" }),
    ];
    await applySync(
      db,
      mailboxId,
      incremental,
      { ...baseCursor, uidNext: 6, messageCount: 5 },
      null,
      null,
    );

    // All 5 messages present, originals untouched
    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.subject).sort()).toEqual([
      "New 1",
      "New 2",
      "Old 1",
      "Old 2",
      "Old 3",
    ]);

    // Cursor reflects the latest sync
    const [mbx] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mbx!.uidNext).toBe(6);
    expect(mbx!.messageCount).toBe(5);
  });

  it("deletes messages not in remoteUids", async () => {
    const synced = [
      buildFetchedMessage({ uid: 1 }),
      buildFetchedMessage({ uid: 2 }),
      buildFetchedMessage({ uid: 3 }),
      buildFetchedMessage({ uid: 4 }),
      buildFetchedMessage({ uid: 5 }),
    ];
    await applySync(
      db,
      mailboxId,
      synced,
      { ...baseCursor, uidNext: 6, messageCount: 5 },
      null,
      null,
    );

    // Server now has only UIDs 1, 3, 5
    const result = await applySync(
      db,
      mailboxId,
      [],
      { ...baseCursor, uidNext: 6, messageCount: 3 },
      [1, 3, 5],
      null,
    );

    expect(result.messagesDeleted).toBe(2);
    expect(result.messagesCreated).toBe(0);

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.providerUid).sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it("deletes all messages when remoteUids is empty", async () => {
    const synced = [
      buildFetchedMessage({ uid: 1 }),
      buildFetchedMessage({ uid: 2 }),
      buildFetchedMessage({ uid: 3 }),
    ];
    await applySync(
      db,
      mailboxId,
      synced,
      { ...baseCursor, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    const result = await applySync(
      db,
      mailboxId,
      [],
      { ...baseCursor, uidNext: 4, messageCount: 0 },
      [],
      null,
    );

    expect(result.messagesDeleted).toBe(3);
    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(0);
  });

  it("inserts new messages and deletes stale ones atomically", async () => {
    // Initial: UIDs 1, 2, 3
    const initial = [
      buildFetchedMessage({ uid: 1, subject: "Keep 1" }),
      buildFetchedMessage({ uid: 2, subject: "Deleted" }),
      buildFetchedMessage({ uid: 3, subject: "Keep 3" }),
    ];
    await applySync(
      db,
      mailboxId,
      initial,
      { ...baseCursor, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    // Server: UID 2 deleted, UIDs 4-5 added
    const newMessages = [
      buildFetchedMessage({ uid: 4, subject: "New 4" }),
      buildFetchedMessage({ uid: 5, subject: "New 5" }),
    ];
    const result = await applySync(
      db,
      mailboxId,
      newMessages,
      { ...baseCursor, uidNext: 6, messageCount: 4 },
      [1, 3, 4, 5],
      null,
    );

    expect(result.messagesCreated).toBe(2);
    expect(result.messagesDeleted).toBe(1);

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.subject).sort()).toEqual(["Keep 1", "Keep 3", "New 4", "New 5"]);
  });

  it("deletes stale rows on UIDVALIDITY change", async () => {
    // Insert 3 messages under uidValidity 100
    const old = [
      buildFetchedMessage({ uid: 1, subject: "Old 1" }),
      buildFetchedMessage({ uid: 2, subject: "Old 2" }),
      buildFetchedMessage({ uid: 3, subject: "Old 3" }),
    ];
    await applySync(
      db,
      mailboxId,
      old,
      { ...baseCursor, uidValidity: 100, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    // Server rebuilt mailbox: new uidValidity 200, one new message
    const fresh = [buildFetchedMessage({ uid: 1, subject: "Fresh 1" })];
    const result = await applySync(
      db,
      mailboxId,
      fresh,
      { ...baseCursor, uidValidity: 200, uidNext: 2, messageCount: 1 },
      null,
      100,
    );

    expect(result.messagesDeleted).toBe(3);
    expect(result.messagesCreated).toBe(1);

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe("Fresh 1");
    expect(rows[0]!.uidValidity).toBe(200);
  });

  it("does not delete messages from other mailboxes", async () => {
    const otherMailboxId = await createTestMailbox(db, accountId, { path: "Sent" });

    // Insert messages in both mailboxes
    const msgs = [buildFetchedMessage({ uid: 1 }), buildFetchedMessage({ uid: 2 })];
    await applySync(
      db,
      mailboxId,
      msgs,
      { ...baseCursor, uidNext: 3, messageCount: 2 },
      null,
      null,
    );
    await applySync(
      db,
      otherMailboxId,
      msgs,
      { ...baseCursor, uidNext: 3, messageCount: 2 },
      null,
      null,
    );

    // Delete all from first mailbox
    await applySync(db, mailboxId, [], { ...baseCursor, uidNext: 3, messageCount: 0 }, [], null);

    // First mailbox empty, other untouched
    const mainRows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(mainRows).toHaveLength(0);

    const otherRows = await db
      .select()
      .from(messages)
      .where(eq(messages.mailboxId, otherMailboxId));
    expect(otherRows).toHaveLength(2);
  });

  it("allows same providerUid under different uidValidity", async () => {
    // First sync: UID 1 under uidValidity 100
    const msg1 = buildFetchedMessage({ uid: 1, subject: "Before rebuild" });
    await applySync(
      db,
      mailboxId,
      [msg1],
      {
        ...baseCursor,
        uidValidity: 100,
        uidNext: 2,
        messageCount: 1,
      },
      null,
      null,
    );

    // Server rebuilds mailbox: same UID 1, new uidValidity 200, different message
    const msg2 = buildFetchedMessage({ uid: 1, subject: "After rebuild" });
    await applySync(
      db,
      mailboxId,
      [msg2],
      {
        ...baseCursor,
        uidValidity: 200,
        uidNext: 2,
        messageCount: 1,
      },
      null,
      null,
    );

    // Both rows exist - different uidValidity means different messages
    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.subject).sort()).toEqual(["After rebuild", "Before rebuild"]);
  });
});
