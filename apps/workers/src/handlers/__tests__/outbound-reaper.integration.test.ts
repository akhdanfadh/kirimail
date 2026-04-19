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
import { reapStaleSentRows, SENT_ROW_REAPER_THRESHOLD_MS } from "../outbound-reaper";

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
  });
  await db
    .update(schema.outboundMessages)
    .set({ status: "sent", sentAt: new Date(Date.now() - offsetMs) })
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

  it("registers a pg-boss queue that dispatches the reaper handler on send", async () => {
    // End-to-end wiring check: `registerOutboundReaper` must create the queue
    // under the expected name and attach the handler so a `boss.send` reaches
    // `reapStaleSentRows`. A typo in the queue name, a missing `boss.work`, or
    // options that reject the send would otherwise only surface in production
    // (the cron would fire into a queue no worker is consuming).
    const staleId = await insertSentRowAgedBy(SENT_ROW_REAPER_THRESHOLD_MS + 60_000);

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerOutboundReaper(boss);
      const spy = boss.getSpy("outbound-reaper");

      await boss.send("outbound-reaper", {});
      await spy.waitForJob(() => true, "completed");

      expect(await getOutboundMessageById(db, staleId)).toBeUndefined();
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
