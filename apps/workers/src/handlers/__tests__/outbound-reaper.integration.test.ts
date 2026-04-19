import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  createEncryptedEmailAccount,
  createSmtpIdentityStub,
  createTestDb,
  createTestUser,
} from "#test/helpers";
import { getOutboundMessageById, insertOutboundMessage } from "@kirimail/db";
import * as schema from "@kirimail/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerOutboundReaper } from "..";
import {
  reapStaleSendingRows,
  reapStaleSentRows,
  SENDING_ROW_REAPER_THRESHOLD_MS,
  SENT_ROW_REAPER_THRESHOLD_MS,
} from "../outbound-reaper";

type Db = NodePgDatabase<typeof schema>;

let db: Db;
let pool: Pool;
let userId: string;
let accountId: string;
let smtpIdentityId: string;

beforeAll(() => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.delete(schema.outboundMessages);
  await db.delete(schema.smtpIdentities);
  await db.delete(schema.emailAccounts);
  await db.delete(schema.users);

  userId = await createTestUser(db);
  accountId = await createEncryptedEmailAccount(db, userId, {
    // distinct user keeps Stalwart state isolated from append-sent tests
    emailUser: "appendsentuser",
  });
  smtpIdentityId = await createSmtpIdentityStub(db, accountId);
});

async function insertSentRowAgedBy(offsetMs: number): Promise<string> {
  const row = await insertOutboundMessage(db, {
    emailAccountId: accountId,
    smtpIdentityId,
    rawMime: Buffer.from("MIME-Version: 1.0\r\n\r\nbody"),
    messageId: `<${randomUUID()}@test.local>`,
    envelopeFrom: "appendsentuser@localhost",
    envelopeTo: ["recipient@localhost"],
  });
  await db
    .update(schema.outboundMessages)
    .set({ status: "sent", sentAt: new Date(Date.now() - offsetMs) })
    .where(eq(schema.outboundMessages.id, row!.id));
  return row!.id;
}

async function insertSendingRowAgedBy(offsetMs: number): Promise<string> {
  const row = await insertOutboundMessage(db, {
    emailAccountId: accountId,
    smtpIdentityId,
    rawMime: Buffer.from("MIME-Version: 1.0\r\n\r\nbody"),
    messageId: `<${randomUUID()}@test.local>`,
    envelopeFrom: "appendsentuser@localhost",
    envelopeTo: ["recipient@localhost"],
  });
  // Set status and backdate updatedAt in one statement: the handler uses
  // updatedAt (not sentAt) as the age signal for sending rows.
  await db
    .update(schema.outboundMessages)
    .set({ status: "sending", updatedAt: new Date(Date.now() - offsetMs) })
    .where(eq(schema.outboundMessages.id, row!.id));
  return row!.id;
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

// Predicate semantics (status filter, strict-`<` cutoff, non-sent rows with
// stale sentAt) are exercised where the SQL lives, in the repository tests
// for `reapStaleSentOutboundMessages`. This file asserts (1) the worker handler
// wires `SENT_ROW_REAPER_THRESHOLD_MS` into that repository call against the
// shared `db` instance, and (2) `registerOutboundReaper` actually registers a
// queue that pg-boss will dispatch to the handler.
describe("outbound-reaper", () => {
  it("uses SENT_ROW_REAPER_THRESHOLD_MS as the cutoff when sweeping", async () => {
    // Pin the threshold math at the handler boundary: a row aged one minute
    // past the threshold is reaped, a row aged one minute inside it is spared.
    // Cheap assertion that the subtraction direction and constant are correct
    // without involving pg-boss.
    const staleId = await insertSentRowAgedBy(SENT_ROW_REAPER_THRESHOLD_MS + 60_000);
    const freshId = await insertSentRowAgedBy(SENT_ROW_REAPER_THRESHOLD_MS - 60_000);

    await reapStaleSentRows();

    expect(await getOutboundMessageById(db, staleId)).toBeUndefined();
    expect(await getOutboundMessageById(db, freshId)).toBeDefined();
  });

  it("marks stuck sending rows failed with delivery-unknown when past the threshold", async () => {
    // Stale sending row -> must be marked failed with delivery-unknown stamped.
    // Fresh sending row -> must stay untouched.
    const staleId = await insertSendingRowAgedBy(SENDING_ROW_REAPER_THRESHOLD_MS + 60_000);
    const freshId = await insertSendingRowAgedBy(SENDING_ROW_REAPER_THRESHOLD_MS - 60_000);

    await reapStaleSendingRows();

    const stale = await getOutboundMessageById(db, staleId);
    expect(stale?.status).toBe("failed");
    expect(stale?.lastErrorCategory).toBe("delivery-unknown");
    expect(stale?.lastError).toContain("delivery status unknown");

    const fresh = await getOutboundMessageById(db, freshId);
    expect(fresh?.status).toBe("sending");
    expect(fresh?.lastErrorCategory).toBeNull();
  });

  it("runs both sweeps in a single pg-boss dispatch", async () => {
    // Also doubles as the wiring smoke test: `registerOutboundReaper` must
    // create the queue under the expected name and attach the handler so
    // `boss.send` dispatches to our sweep code. A typo in the queue name, a
    // missing `boss.work`, or options rejecting the send would otherwise
    // only surface in production (the cron firing into a queue no worker
    // consumes). Beyond wiring, the test pins that both reapers fire per
    // trigger - a missing await on one sweep would drop this to single-row.
    const staleSentId = await insertSentRowAgedBy(SENT_ROW_REAPER_THRESHOLD_MS + 60_000);
    const staleSendingId = await insertSendingRowAgedBy(SENDING_ROW_REAPER_THRESHOLD_MS + 60_000);

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerOutboundReaper(boss);
      const spy = boss.getSpy("outbound-reaper");

      await boss.send("outbound-reaper", {});
      await spy.waitForJob(() => true, "completed");

      // Sent row deleted.
      expect(await getOutboundMessageById(db, staleSentId)).toBeUndefined();
      // Sending row marked failed (not deleted).
      const sending = await getOutboundMessageById(db, staleSendingId);
      expect(sending?.status).toBe("failed");
      expect(sending?.lastErrorCategory).toBe("delivery-unknown");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
