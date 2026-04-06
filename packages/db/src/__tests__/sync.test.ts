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

    const result = await applySync(db, mailboxId, synced, cursor);

    expect(result.messagesCreated).toBe(3);

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

    await applySync(db, mailboxId, synced, cursor);
    await applySync(db, mailboxId, synced, cursor);

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(2);
  });

  it("updates cursor even with empty message array", async () => {
    const cursor = { uidValidity: 42, uidNext: 100, messageCount: 0, highestModseq: null };

    const result = await applySync(db, mailboxId, [], cursor);

    expect(result.messagesCreated).toBe(0);

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
    await applySync(db, mailboxId, initial, { ...baseCursor, uidNext: 4, messageCount: 3 });

    // Incremental sync: 2 new messages
    const incremental = [
      buildFetchedMessage({ uid: 4, subject: "New 1" }),
      buildFetchedMessage({ uid: 5, subject: "New 2" }),
    ];
    await applySync(db, mailboxId, incremental, { ...baseCursor, uidNext: 6, messageCount: 5 });

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

  it("allows same providerUid under different uidValidity", async () => {
    // First sync: UID 1 under uidValidity 100
    const msg1 = buildFetchedMessage({ uid: 1, subject: "Before rebuild" });
    await applySync(db, mailboxId, [msg1], {
      ...baseCursor,
      uidValidity: 100,
      uidNext: 2,
      messageCount: 1,
    });

    // Server rebuilds mailbox: same UID 1, new uidValidity 200, different message
    const msg2 = buildFetchedMessage({ uid: 1, subject: "After rebuild" });
    await applySync(db, mailboxId, [msg2], {
      ...baseCursor,
      uidValidity: 200,
      uidNext: 2,
      messageCount: 1,
    });

    // Both rows exist - different uidValidity means different messages
    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.subject).sort()).toEqual(["After rebuild", "Before rebuild"]);
  });
});
