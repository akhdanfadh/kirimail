import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  cleanImapState,
  createEncryptedEmailAccount,
  createSmtpIdentityStub,
  createTestDb,
  createTestUser,
  seedSentMailbox,
} from "#test/helpers";
import {
  getOutboundMessageById,
  insertOutboundMessage,
  markPendingOutboundMessageSending,
  markSendingOutboundMessageSent,
} from "@kirimail/db";
import * as schema from "@kirimail/db/schema";
import { testCredentials, withImapConnection } from "@kirimail/mail/testing";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerAppendSent } from "..";

type Db = NodePgDatabase<typeof schema>;

let db: Db;
let pool: Pool;
let userId: string;
let accountId: string;
let smtpIdentityId: string;

const creds = () => testCredentials("appendsentuser");

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
  await db.delete(schema.outboundMessages);
  await db.delete(schema.smtpIdentities);
  await db.delete(schema.messages);
  await db.delete(schema.mailboxes);
  await db.delete(schema.emailAccounts);
  await db.delete(schema.users);

  await cleanImapState(creds());

  userId = await createTestUser(db);
  accountId = await createEncryptedEmailAccount(db, userId, {
    emailUser: "appendsentuser",
  });
  smtpIdentityId = await createSmtpIdentityStub(db, accountId);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateMessageId(): string {
  return `<${randomUUID()}@test.local>`;
}

function buildTestMime(messageId: string, subject = "Append-Sent Test"): Buffer {
  const lines = [
    "From: appendsentuser@localhost",
    "To: recipient@localhost",
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Integration test body.",
  ];
  return Buffer.from(lines.join("\r\n"));
}

async function seedSentRow(messageId: string, raw: Buffer): Promise<string> {
  const row = await insertOutboundMessage(db, {
    emailAccountId: accountId,
    smtpIdentityId,
    rawMime: raw,
    messageId,
  });
  if (!row) throw new Error("insertOutboundMessage returned undefined");
  await markPendingOutboundMessageSending(db, row.id);
  await markSendingOutboundMessageSent(db, row.id);
  return row.id;
}

/**
 * Fetch all Message-IDs currently in the given mailbox via FETCH ENVELOPE.
 * Equality-check surface for APPEND / dedup assertions.
 */
async function fetchMessageIds(mailboxPath: string): Promise<string[]> {
  return withImapConnection(creds(), async (client) => {
    const lock = await client.getMailboxLock(mailboxPath, { readOnly: true });
    try {
      if (!client.mailbox || client.mailbox.exists === 0) return [];
      const ids: string[] = [];
      for await (const msg of client.fetch({ all: true }, { envelope: true }, { uid: true })) {
        if (msg.envelope?.messageId) ids.push(msg.envelope.messageId);
      }
      return ids;
    } finally {
      lock.release();
    }
  });
}

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

describe("append-sent via pg-boss", () => {
  it("appends a sent row to Sent and deletes the row", async () => {
    await seedSentMailbox(db, accountId, creds());
    const messageId = generateMessageId();
    const raw = buildTestMime(messageId, "Happy-Path");
    const rowId = await seedSentRow(messageId, raw);

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerAppendSent(boss);
      const spy = boss.getSpy("append-sent");

      await boss.send("append-sent", { outboundMessageId: rowId });
      await spy.waitForJob(() => true, "completed");

      const ids = await fetchMessageIds("Sent");
      expect(ids).toHaveLength(1);
      expect(ids[0]).toContain(messageId.replace(/[<>]/g, ""));

      expect(await getOutboundMessageById(db, rowId)).toBeUndefined();
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("short-circuits on dedup and still deletes the row", async () => {
    await seedSentMailbox(db, accountId, creds());
    const messageId = generateMessageId();
    const raw = buildTestMime(messageId, "Dedup");

    // Pre-APPEND the same bytes directly to Sent so the probe finds them.
    await withImapConnection(creds(), async (client) => {
      await client.append("Sent", raw, ["\\Seen"]);
    });

    const rowId = await seedSentRow(messageId, raw);

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerAppendSent(boss);
      const spy = boss.getSpy("append-sent");

      await boss.send("append-sent", { outboundMessageId: rowId });
      await spy.waitForJob(() => true, "completed");

      // The dedup probe itself is covered in @kirimail/mail tests - the unique
      // handler contract here is "delete the row even when APPEND short-circuited".
      expect(await getOutboundMessageById(db, rowId)).toBeUndefined();
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("completes gracefully when the outbound row does not exist", async () => {
    const boss = createTestBoss();
    await boss.start();
    try {
      await registerAppendSent(boss);
      const spy = boss.getSpy("append-sent");

      await boss.send("append-sent", { outboundMessageId: randomUUID() });
      await spy.waitForJob(() => true, "completed");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("leaves the row alone when the Sent mailbox is not mapped", async () => {
    // Deliberately skip seedSentMailbox - no mailboxes row with role='sent'.
    const messageId = generateMessageId();
    const raw = buildTestMime(messageId, "Unmapped");
    const rowId = await seedSentRow(messageId, raw);

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerAppendSent(boss);
      const spy = boss.getSpy("append-sent");

      await boss.send("append-sent", { outboundMessageId: rowId });
      await spy.waitForJob(() => true, "completed");

      const row = await getOutboundMessageById(db, rowId);
      expect(row).toBeDefined();
      expect(row!.status).toBe("sent");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("leaves a row in pending alone without APPEND or delete", async () => {
    await seedSentMailbox(db, accountId, creds());
    const messageId = generateMessageId();
    const raw = buildTestMime(messageId, "Wrong-State");

    // Defense-in-depth: the repository state machine has no transition out of
    // `sent` and send-email only enqueues append-sent after the markSent tx
    // commits, so a `pending` row reaching this handler implies out-of-band
    // mutation (direct SQL, migration, future bug). The handler must still
    // refuse to APPEND or delete.
    const inserted = await insertOutboundMessage(db, {
      emailAccountId: accountId,
      smtpIdentityId,
      rawMime: raw,
      messageId,
    });
    expect(inserted).toBeDefined();
    const insertedId = inserted!.id;

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerAppendSent(boss);
      const spy = boss.getSpy("append-sent");

      await boss.send("append-sent", { outboundMessageId: insertedId });
      await spy.waitForJob(() => true, "completed");

      const row = await getOutboundMessageById(db, insertedId);
      expect(row).toBeDefined();
      expect(row!.status).toBe("pending");

      const ids = await fetchMessageIds("Sent");
      expect(ids).toHaveLength(0);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("leaves a sent row untouched when the stored Message-ID is malformed", async () => {
    await seedSentMailbox(db, accountId, creds());
    // Message-ID without angle brackets triggers ImapPrimitiveNonRetriableError
    // inside appendToMailbox's assertMessageId guard. Use a raw MIME whose
    // header matches so insertOutboundMessage doesn't choke on its own validation.
    const malformedId = `malformed-${randomUUID()}@test.local`;
    const raw = buildTestMime(`<${malformedId}>`, "Malformed-ID");
    const row = await insertOutboundMessage(db, {
      emailAccountId: accountId,
      smtpIdentityId,
      rawMime: raw,
      messageId: malformedId, // no angle brackets - triggers non-retriable error
    });
    expect(row).toBeDefined();
    const rowId = row!.id;
    await markPendingOutboundMessageSending(db, rowId);
    await markSendingOutboundMessageSent(db, rowId);

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerAppendSent(boss);
      const spy = boss.getSpy("append-sent");

      await boss.send("append-sent", { outboundMessageId: rowId });
      // Handler catches ImapPrimitiveNonRetriableError and returns, so pg-boss
      // marks the job completed rather than burning retries. The row stays in
      // `sent`; the reaper cleans it on the 6h cycle.
      await spy.waitForJob(() => true, "completed");

      const persisted = await getOutboundMessageById(db, rowId);
      expect(persisted).toBeDefined();
      expect(persisted!.status).toBe("sent");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
