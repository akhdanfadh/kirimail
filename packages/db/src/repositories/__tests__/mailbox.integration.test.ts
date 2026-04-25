import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  buildFetchedMessage,
  createTestDb,
  createTestEmailAccount,
  createTestMailbox,
  createTestUser,
} from "#test/helpers";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as schema from "../../schema";

import { domainEvents, mailboxes, messages } from "../../schema";
import { applyMailboxSync, reconcileMailboxes } from "../mailbox";

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
  await db.delete(domainEvents);
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

describe("applyMailboxSync", () => {
  it("inserts messages and updates the mailbox cursor", async () => {
    const synced = [
      buildFetchedMessage({ uid: 1, subject: "First", flags: new Set(["\\Seen"]) }),
      buildFetchedMessage({ uid: 2, subject: "Second", messageId: null }),
      buildFetchedMessage({ uid: 3, subject: "Third", flags: new Set(["\\Seen", "\\Flagged"]) }),
    ];
    const cursor = { ...baseCursor, messageCount: 3, uidNext: 4 };

    const result = await applyMailboxSync(db, mailboxId, synced, cursor, null, null);

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

  it("round-trips attachments metadata on insert", async () => {
    // Shape covers each field's value space: non-null filename vs null,
    // known vs null size, populated vs null contentId, all three
    // disposition tokens, and a descendant partPath for a forward-nested
    // entry. jsonb must preserve everything verbatim.
    const attachments = [
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 54321,
        contentId: null,
        disposition: "attachment" as const,
        partPath: "2",
      },
      {
        filename: "logo.png",
        mimeType: "image/png",
        size: 9876,
        contentId: "logo@example.com",
        disposition: "inline" as const,
        partPath: "3",
      },
      {
        filename: null,
        mimeType: "application/octet-stream",
        size: null,
        contentId: null,
        disposition: null,
        partPath: "4.2",
      },
    ];
    const synced = [
      buildFetchedMessage({ uid: 10, subject: "With attachments", attachments }),
      buildFetchedMessage({ uid: 11, subject: "No attachments" }),
    ];

    await applyMailboxSync(
      db,
      mailboxId,
      synced,
      { ...baseCursor, uidNext: 12, messageCount: 2 },
      null,
      null,
    );

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    const withAttachments = rows.find((r) => r.subject === "With attachments");
    const withoutAttachments = rows.find((r) => r.subject === "No attachments");

    expect(withAttachments!.attachments).toEqual(attachments);
    expect(withoutAttachments!.attachments).toEqual([]);
  });

  it("round-trips encrypted flag and defaults to false on insert", async () => {
    // Two messages: one encrypted, one default. Asserts both the column round-trip
    // (true persists as true) and the default (omitting the override stores false).
    // Default-false is the load-bearing case since most messages take that branch.
    const synced = [
      buildFetchedMessage({ uid: 20, subject: "Encrypted body", encrypted: true }),
      buildFetchedMessage({ uid: 21, subject: "Plain body" }),
    ];

    await applyMailboxSync(
      db,
      mailboxId,
      synced,
      { ...baseCursor, uidNext: 22, messageCount: 2 },
      null,
      null,
    );

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    const encryptedRow = rows.find((r) => r.subject === "Encrypted body");
    const plainRow = rows.find((r) => r.subject === "Plain body");

    expect(encryptedRow!.encrypted).toBe(true);
    expect(plainRow!.encrypted).toBe(false);
  });

  it("is idempotent when re-applied with the same data", async () => {
    const synced = [buildFetchedMessage({ uid: 1 }), buildFetchedMessage({ uid: 2 })];
    const cursor = { ...baseCursor, uidNext: 3, messageCount: 2 };

    const first = await applyMailboxSync(db, mailboxId, synced, cursor, null, null);
    expect(first.messagesCreated).toBe(2);

    const second = await applyMailboxSync(db, mailboxId, synced, cursor, null, null);
    expect(second.messagesCreated).toBe(0);

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(2);
  });

  it("updates cursor even with empty message array", async () => {
    const cursor = { uidValidity: 42, uidNext: 100, messageCount: 0, highestModseq: null };

    const result = await applyMailboxSync(db, mailboxId, [], cursor, null, null);

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
    await applyMailboxSync(
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
    await applyMailboxSync(
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
    await applyMailboxSync(
      db,
      mailboxId,
      synced,
      { ...baseCursor, uidNext: 6, messageCount: 5 },
      null,
      null,
    );

    // Server now has only UIDs 1, 3, 5
    const result = await applyMailboxSync(
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
    await applyMailboxSync(
      db,
      mailboxId,
      synced,
      { ...baseCursor, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    const result = await applyMailboxSync(
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
    await applyMailboxSync(
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
    const result = await applyMailboxSync(
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
    await applyMailboxSync(
      db,
      mailboxId,
      old,
      { ...baseCursor, uidValidity: 100, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    // Server rebuilt mailbox: new uidValidity 200, one new message
    const fresh = [buildFetchedMessage({ uid: 1, subject: "Fresh 1" })];
    const result = await applyMailboxSync(
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
    await applyMailboxSync(
      db,
      mailboxId,
      msgs,
      { ...baseCursor, uidNext: 3, messageCount: 2 },
      null,
      null,
    );
    await applyMailboxSync(
      db,
      otherMailboxId,
      msgs,
      { ...baseCursor, uidNext: 3, messageCount: 2 },
      null,
      null,
    );

    // Delete all from first mailbox
    await applyMailboxSync(
      db,
      mailboxId,
      [],
      { ...baseCursor, uidNext: 3, messageCount: 0 },
      [],
      null,
    );

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
    await applyMailboxSync(
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
    await applyMailboxSync(
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

  it("handles UIDVALIDITY change with remoteUids in the same call", async () => {
    // Seed 3 messages under uidValidity 100
    await applyMailboxSync(
      db,
      mailboxId,
      [
        buildFetchedMessage({ uid: 1, subject: "Old 1" }),
        buildFetchedMessage({ uid: 2, subject: "Old 2" }),
        buildFetchedMessage({ uid: 3, subject: "Old 3" }),
      ],
      { ...baseCursor, uidValidity: 100, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    // Server rebuilt mailbox (new uidValidity 200) with UIDs 1-2.
    // Full resync: purge old uidValidity + reconcile new UID set.
    const result = await applyMailboxSync(
      db,
      mailboxId,
      [
        buildFetchedMessage({ uid: 1, subject: "Fresh 1" }),
        buildFetchedMessage({ uid: 2, subject: "Fresh 2" }),
      ],
      { ...baseCursor, uidValidity: 200, uidNext: 3, messageCount: 2 },
      [1, 2],
      100,
    );

    // Step 1 purges 3 old rows, step 2 finds nothing extra to delete (new UIDs match)
    expect(result.messagesDeleted).toBe(3);
    expect(result.messagesCreated).toBe(2);

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.uidValidity === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyMailboxSync - domain event emission
// ---------------------------------------------------------------------------

describe("applyMailboxSync domain event emission", () => {
  it("emits one message.synced event per newly-inserted message row", async () => {
    // Pins the producer-side one-to-one contract. Every new message
    // row must land with exactly one matching domain_events row in the
    // same transaction, so downstream consumers cannot miss a message.
    const synced = [
      buildFetchedMessage({ uid: 1, subject: "First" }),
      buildFetchedMessage({ uid: 2, subject: "Second" }),
      buildFetchedMessage({ uid: 3, subject: "Third" }),
    ];

    await applyMailboxSync(
      db,
      mailboxId,
      synced,
      { ...baseCursor, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    const insertedMessages = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.mailboxId, mailboxId));
    const events = await db.select().from(domainEvents);

    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.aggregateId))).toEqual(
      new Set(insertedMessages.map((r) => r.id)),
    );
    for (const event of events) {
      expect(event.aggregateType).toBe("message");
      expect(event.eventType).toBe("message.synced");
      expect(event.payload).toEqual({});
    }
  });

  it("emits zero events on a re-sync that inserts zero rows", async () => {
    // Idempotence: onConflictDoNothing returns an empty RETURNING set
    // for duplicate UIDs, so a no-op re-sync must not flood domain_events.
    // A regression here would re-index the whole mailbox every tick.
    const synced = [buildFetchedMessage({ uid: 1 }), buildFetchedMessage({ uid: 2 })];
    const cursor = { ...baseCursor, uidNext: 3, messageCount: 2 };

    await applyMailboxSync(db, mailboxId, synced, cursor, null, null);
    const firstCount = (await db.select().from(domainEvents)).length;
    expect(firstCount).toBe(2);

    await applyMailboxSync(db, mailboxId, synced, cursor, null, null);
    const secondCount = (await db.select().from(domainEvents)).length;
    expect(secondCount).toBe(firstCount);
  });

  it("rolls back the message insert when the event insert fails mid-transaction", async () => {
    // Atomic-pair proof: a transient CHECK constraint forces the event
    // insert to fail after the message insert has staged rows, so the
    // messages row must roll back with it. A regression that pulls event
    // emission out of the tx would leave orphan message rows.
    //
    // Don't "simplify" this with a test-owned outer tx - `applyMailboxSync`
    // opens its own tx, which would downgrade to a savepoint and mask the
    // rollback signal we're trying to observe.
    await db.execute(
      sql`ALTER TABLE domain_events ADD CONSTRAINT tmp_fail_message_synced CHECK (event_type <> 'message.synced')`,
    );
    try {
      await expect(
        applyMailboxSync(
          db,
          mailboxId,
          [buildFetchedMessage({ uid: 1 })],
          { ...baseCursor, uidNext: 2, messageCount: 1 },
          null,
          null,
        ),
        // Matches the Drizzle error wrapping the CHECK-constraint failure on
        // the domain_events insert - proves the throw came from event-side,
        // not from a message-side regression.
      ).rejects.toThrow(/domain_events/);

      const messageRows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
      const eventRows = await db.select().from(domainEvents);
      expect(messageRows).toHaveLength(0);
      expect(eventRows).toHaveLength(0);
    } finally {
      await db.execute(sql`ALTER TABLE domain_events DROP CONSTRAINT tmp_fail_message_synced`);
    }
  });

  it("emits events only for newly-inserted rows when the batch mixes new and existing UIDs", async () => {
    // The boundary case Tests 1 and 2 leave open: onConflictDoNothing skips
    // some rows and inserts others. A regression that emitted per
    // fetchedMessage instead of per inserted row would pass the all-new
    // and all-existing tests but flood the table here.
    const initial = [buildFetchedMessage({ uid: 1 }), buildFetchedMessage({ uid: 2 })];
    await applyMailboxSync(
      db,
      mailboxId,
      initial,
      { ...baseCursor, uidNext: 3, messageCount: 2 },
      null,
      null,
    );

    const mixed = [
      buildFetchedMessage({ uid: 1 }), // existing
      buildFetchedMessage({ uid: 2 }), // existing
      buildFetchedMessage({ uid: 3 }), // new
    ];
    await applyMailboxSync(
      db,
      mailboxId,
      mixed,
      { ...baseCursor, uidNext: 4, messageCount: 3 },
      null,
      null,
    );

    const events = await db.select().from(domainEvents);
    expect(events).toHaveLength(3); // 2 from initial + 1 from mixed
  });

  it("emits no events for UIDVALIDITY-purge or incremental-delete paths", async () => {
    // Pins the producer's stated intent that deletions don't emit. A
    // future contributor wiring message.deleted emission could accidentally
    // attach it to the UIDVALIDITY-purge path (which represents server-side
    // reset, not user-visible deletion) - this test catches that.
    await applyMailboxSync(
      db,
      mailboxId,
      [buildFetchedMessage({ uid: 1 })],
      { ...baseCursor, uidNext: 2, messageCount: 1 },
      null,
      null,
    );
    await db.delete(domainEvents); // reset the emit-on-insert noise from seeding

    // Incremental delete: server reports empty UID set.
    await applyMailboxSync(
      db,
      mailboxId,
      [],
      { ...baseCursor, uidNext: 2, messageCount: 0 },
      [],
      null,
    );
    expect(await db.select().from(domainEvents)).toHaveLength(0);

    // UIDVALIDITY purge: old rows wiped, no new fetch.
    await applyMailboxSync(
      db,
      mailboxId,
      [],
      { ...baseCursor, uidValidity: 999, uidNext: 1, messageCount: 0 },
      null,
      baseCursor.uidValidity,
    );
    expect(await db.select().from(domainEvents)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reconcileMailboxes
// ---------------------------------------------------------------------------

describe("reconcileMailboxes", () => {
  it("creates mailboxes from a flat discovery", async () => {
    const result = await reconcileMailboxes(db, accountId, [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: { uidValidity: 1, uidNext: 50, messageCount: 49, highestModseq: 100 },
        children: [],
      },
      {
        path: "Sent",
        delimiter: "/",
        specialUse: "\\Sent",
        role: "sent",
        syncCursor: null,
        children: [],
      },
    ]);

    // INBOX exists from beforeEach but metadata differs (delimiter, specialUse)
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.mailboxByPath.size).toBe(2);

    // Reconcile does not write cursors - applyMailboxSync owns them.
    // INBOX has no cursor (createTestMailbox doesn't set one), Sent is new.
    const inbox = result.mailboxByPath.get("INBOX")!;
    expect(inbox.storedCursor).toBeNull();

    const sent = result.mailboxByPath.get("Sent")!;
    expect(sent.storedCursor).toBeNull();

    // Verify metadata was persisted to DB (not just counted)
    const [inboxRow] = await db
      .select({
        delimiter: mailboxes.delimiter,
        specialUse: mailboxes.specialUse,
        role: mailboxes.role,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, inbox.id));
    expect(inboxRow!.delimiter).toBe("/");
    expect(inboxRow!.specialUse).toBe("\\Inbox");
    expect(inboxRow!.role).toBe("inbox");
  });

  it("builds parent-child hierarchy", async () => {
    await reconcileMailboxes(db, accountId, [
      {
        path: "Work",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [
          {
            path: "Work/Projects",
            delimiter: "/",
            specialUse: null,
            role: "custom",
            syncCursor: null,
            children: [],
          },
        ],
      },
    ]);

    const rows = await db
      .select({ path: mailboxes.path, parentId: mailboxes.parentId })
      .from(mailboxes)
      .where(eq(mailboxes.emailAccountId, accountId));

    const parent = rows.find((r) => r.path === "Work")!;
    const child = rows.find((r) => r.path === "Work/Projects")!;

    expect(parent.parentId).toBeNull();
    expect(child.parentId).toBe(
      (await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.path, "Work")))[0]!
        .id,
    );
  });

  it("preserves applyMailboxSync cursor when metadata changes on re-discovery", async () => {
    // Simulate applyMailboxSync having written a cursor to the existing INBOX
    const [row] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.path, "INBOX"));
    await db
      .update(mailboxes)
      .set({ uidValidity: 1, uidNext: 200, messageCount: 199, highestModseq: 500 })
      .where(eq(mailboxes.id, row!.id));

    // Re-discover with a metadata change (role) but reconcile must not touch cursor
    const result = await reconcileMailboxes(db, accountId, [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: { uidValidity: 1, uidNext: 300, messageCount: 299, highestModseq: 700 },
        children: [],
      },
    ]);

    // Cursor from applyMailboxSync is preserved, not overwritten by LIST-STATUS
    const inbox = result.mailboxByPath.get("INBOX")!;
    expect(inbox.storedCursor!.uidNext).toBe(200);
    expect(inbox.storedCursor!.highestModseq).toBe(500);
  });

  it("removes stale mailboxes not in discovered set", async () => {
    // Create two mailboxes
    await reconcileMailboxes(db, accountId, [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: null,
        children: [],
      },
      {
        path: "OldFolder",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [],
      },
    ]);

    // Re-discover with OldFolder removed
    const result = await reconcileMailboxes(db, accountId, [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: null,
        children: [],
      },
    ]);

    expect(result.removed).toBe(1);

    const rows = await db
      .select({ path: mailboxes.path })
      .from(mailboxes)
      .where(eq(mailboxes.emailAccountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe("INBOX");
  });

  it("cascades message deletion when stale mailbox is removed", async () => {
    // Create mailbox and sync messages into it
    const { mailboxByPath } = await reconcileMailboxes(db, accountId, [
      {
        path: "Trash",
        delimiter: "/",
        specialUse: "\\Trash",
        role: "trash",
        syncCursor: null,
        children: [],
      },
    ]);
    const trashId = mailboxByPath.get("Trash")!.id;

    await applyMailboxSync(
      db,
      trashId,
      [buildFetchedMessage({ uid: 1 }), buildFetchedMessage({ uid: 2 })],
      { uidValidity: 1, uidNext: 3, messageCount: 2, highestModseq: null },
      null,
      null,
    );

    // Re-discover without Trash -> mailbox + messages removed
    await reconcileMailboxes(db, accountId, []);

    const msgRows = await db.select().from(messages).where(eq(messages.mailboxId, trashId));
    expect(msgRows).toHaveLength(0);
  });

  it("does not affect other accounts when removing stale mailboxes", async () => {
    const otherAccountId = await createTestEmailAccount(db, userId);

    // Both accounts have INBOX
    await reconcileMailboxes(db, accountId, [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: null,
        children: [],
      },
      {
        path: "OldFolder",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [],
      },
    ]);
    await reconcileMailboxes(db, otherAccountId, [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: null,
        children: [],
      },
    ]);

    // Remove OldFolder from first account
    await reconcileMailboxes(db, accountId, [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: null,
        children: [],
      },
    ]);

    // Other account's INBOX untouched
    const otherRows = await db
      .select({ path: mailboxes.path })
      .from(mailboxes)
      .where(eq(mailboxes.emailAccountId, otherAccountId));
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]!.path).toBe("INBOX");
  });

  it("is idempotent on repeated discovery with same data", async () => {
    const tree: Parameters<typeof reconcileMailboxes>[2] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: { uidValidity: 1, uidNext: 10, messageCount: 9, highestModseq: null },
        children: [],
      },
    ];

    const first = await reconcileMailboxes(db, accountId, tree);
    const second = await reconcileMailboxes(db, accountId, tree);

    // Same mailbox ID reused, no writes at all
    expect(first.mailboxByPath.get("INBOX")!.id).toBe(second.mailboxByPath.get("INBOX")!.id);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.removed).toBe(0);

    const rows = await db.select().from(mailboxes).where(eq(mailboxes.emailAccountId, accountId));
    expect(rows).toHaveLength(1);
  });

  it("clears parentId when child is promoted to root", async () => {
    // Create parent -> child hierarchy
    await reconcileMailboxes(db, accountId, [
      {
        path: "Work",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [
          {
            path: "Work/Projects",
            delimiter: "/",
            specialUse: null,
            role: "custom",
            syncCursor: null,
            children: [],
          },
        ],
      },
    ]);

    // Server removes Work, child becomes root
    await reconcileMailboxes(db, accountId, [
      {
        path: "Work/Projects",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [],
      },
    ]);

    const [projects] = await db
      .select({ parentId: mailboxes.parentId })
      .from(mailboxes)
      .where(eq(mailboxes.path, "Work/Projects"));
    expect(projects!.parentId).toBeNull();

    // Work was deleted
    const rows = await db.select().from(mailboxes).where(eq(mailboxes.emailAccountId, accountId));
    expect(rows).toHaveLength(1);
  });

  it("re-parents a child from one parent to another", async () => {
    // Create Work/Projects and Personal
    await reconcileMailboxes(db, accountId, [
      {
        path: "Work",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [
          {
            path: "Work/Projects",
            delimiter: "/",
            specialUse: null,
            role: "custom",
            syncCursor: null,
            children: [],
          },
        ],
      },
      {
        path: "Personal",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [],
      },
    ]);

    // Move Projects from Work to Personal
    const result = await reconcileMailboxes(db, accountId, [
      {
        path: "Work",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [],
      },
      {
        path: "Personal",
        delimiter: "/",
        specialUse: null,
        role: "custom",
        syncCursor: null,
        children: [
          {
            path: "Work/Projects",
            delimiter: "/",
            specialUse: null,
            role: "custom",
            syncCursor: null,
            children: [],
          },
        ],
      },
    ]);

    const personalId = result.mailboxByPath.get("Personal")!.id;
    const [projects] = await db
      .select({ parentId: mailboxes.parentId })
      .from(mailboxes)
      .where(eq(mailboxes.path, "Work/Projects"));
    expect(projects!.parentId).toBe(personalId);
  });

  it("treats server-side rename as delete + insert (messages lost)", async () => {
    // Seed INBOX with messages via applyMailboxSync
    await applyMailboxSync(
      db,
      mailboxId,
      [buildFetchedMessage({ uid: 1 }), buildFetchedMessage({ uid: 2 })],
      { uidValidity: 1, uidNext: 3, messageCount: 2, highestModseq: null },
      null,
      null,
    );

    // Server renamed INBOX -> Primary. Old path gone, new path appeared.
    // Known limitation (see TODO in reconcileMailboxes): identity is keyed
    // on path, so this looks like a deletion + a new mailbox.
    const result = await reconcileMailboxes(db, accountId, [
      {
        path: "Primary",
        delimiter: "/",
        specialUse: "\\Inbox",
        role: "inbox",
        syncCursor: { uidValidity: 1, uidNext: 3, messageCount: 2, highestModseq: null },
        children: [],
      },
    ]);

    expect(result.removed).toBe(1);
    expect(result.inserted).toBe(1);

    // Messages from old INBOX are gone (CASCADE on mailbox deletion)
    const msgRows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(msgRows).toHaveLength(0);

    // New mailbox starts with null cursor -> full initial resync
    const primary = result.mailboxByPath.get("Primary")!;
    expect(primary.storedCursor).toBeNull();
  });
});
