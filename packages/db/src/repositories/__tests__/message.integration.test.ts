import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  createTestDb,
  createTestEmailAccount,
  createTestMailbox,
  createTestUser,
} from "#test/helpers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as schema from "../../schema";

import { generateId } from "../../id";
import { emailAccounts, mailboxes, messages, users } from "../../schema";
import { getMessageWithOwnership } from "../message";

type Db = NodePgDatabase<typeof schema>;

let db: Db;
let pool: Pool;

beforeAll(() => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Reverse FK order.
  await db.delete(messages);
  await db.delete(mailboxes);
  await db.delete(emailAccounts);
  await db.delete(users);
});

describe("getMessageWithOwnership", () => {
  it("resolves the full tenant-ownership chain for an existing message id", async () => {
    // Pins the `messages -> mailboxes -> email_accounts` join chain.
    // Both `emailAccountId` and `userId` are `text`, so a typo that
    // joined e.g. `mailboxes.emailAccountId -> emailAccounts.userId`
    // would still type-check and would silently surface the wrong
    // `userId`. Asserting every hop resolves to the row we seeded
    // catches that.
    const userId = await createTestUser(db);
    const emailAccountId = await createTestEmailAccount(db, userId);
    const mailboxId = await createTestMailbox(db, emailAccountId);

    const messageId = generateId();
    const internalDate = new Date("2026-01-01T00:00:00Z");
    const attachments = [
      {
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 1234,
        contentId: null,
        disposition: "attachment" as const,
        partPath: "2",
      },
    ];
    await db.insert(messages).values({
      id: messageId,
      mailboxId,
      providerUid: 1,
      uidValidity: 1,
      subject: "Join me",
      fromAddress: [{ name: "Alice", address: "alice@test.local" }],
      toAddress: [{ name: "Bob", address: "bob@test.local" }],
      ccAddress: [{ name: "Carol", address: "carol@test.local" }],
      bccAddress: [{ name: "Dave", address: "dave@test.local" }],
      flags: ["\\Seen"],
      attachments,
      internalDate,
      sizeOctets: 2048,
    });

    // Read the seeded row back and assert the join result equals it
    // plus the two joined columns. Catches a column silently dropping
    // out of `getTableColumns(messages)` (Drizzle version change,
    // schema edit) without forcing this test to re-list every column
    // by hand.
    const [seeded] = await db.select().from(messages).where(eq(messages.id, messageId));
    const row = await getMessageWithOwnership(db, messageId);
    expect(row).toEqual({
      message: seeded,
      emailAccountId,
      userId,
    });
  });

  it("returns null when no message matches the id", async () => {
    // Pins the contract that the function returns `null` (not
    // `undefined`) on no match. TypeScript alone can't tell the two
    // apart here because both satisfy `MessageWithOwnership | null`,
    // and what Drizzle returns when there are no rows is library
    // behavior worth pinning against upgrades.
    expect(await getMessageWithOwnership(db, "nonexistent")).toBeNull();
  });

  it("isolates the ownership chain per message across multiple users and accounts", async () => {
    // Catches the class of bugs the single-seed happy path can't: a
    // missing WHERE, or a join that crosses every row with every other
    // row (a "cartesian join"). With only one row in each table, a
    // broken predicate still returns the only row and looks correct.
    // Two independent chains force the WHERE + JOIN to actually filter,
    // so mixing up a hop (e.g. resolving `userId` through the wrong
    // account) shows up as a crossed assertion.
    const user1 = await createTestUser(db);
    const account1 = await createTestEmailAccount(db, user1);
    const mailbox1 = await createTestMailbox(db, account1);
    const message1 = generateId();
    await db.insert(messages).values({
      id: message1,
      mailboxId: mailbox1,
      providerUid: 1,
      uidValidity: 1,
      internalDate: new Date("2026-01-01T00:00:00Z"),
    });

    const user2 = await createTestUser(db);
    const account2 = await createTestEmailAccount(db, user2);
    const mailbox2 = await createTestMailbox(db, account2);
    const message2 = generateId();
    await db.insert(messages).values({
      id: message2,
      mailboxId: mailbox2,
      providerUid: 1,
      uidValidity: 1,
      internalDate: new Date("2026-01-01T00:00:00Z"),
    });

    expect(await getMessageWithOwnership(db, message1)).toMatchObject({
      message: { id: message1, mailboxId: mailbox1 },
      emailAccountId: account1,
      userId: user1,
    });
    expect(await getMessageWithOwnership(db, message2)).toMatchObject({
      message: { id: message2, mailboxId: mailbox2 },
      emailAccountId: account2,
      userId: user2,
    });
  });
});
