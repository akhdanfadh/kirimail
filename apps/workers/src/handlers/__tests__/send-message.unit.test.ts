/**
 * Unit tests for send-message handler branches that the integration tests
 * can't reach via real Stalwart interaction:
 *
 * - Zero-accepted defensive guard (a conforming SMTP server can't return
 *   250/DATA with accepted=[]; nodemailer would throw EENVELOPE).
 * - Partial-rejection passthrough at the handler layer (the handler wiring
 *   of `result.rejected` into `markSent`; Stalwart won't produce partial
 *   DATA rejection easily).
 * - `boss.send` throw on append-sent enqueue (catch-and-log contract; the
 *   real pg-boss doesn't fail at that site under normal operation).
 *
 * Mocks the shared `smtpCache` and uses a lightweight boss double. Real
 * pg, real schema, real rows - only the SMTP wire and boss.send are faked.
 */
import type { SmtpSendResult } from "@kirimail/mail";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";

import {
  createEncryptedEmailAccount,
  createEncryptedSmtpIdentity,
  createTestDb,
  createTestUser,
} from "#test/helpers";
import { getOutboundMessageById, insertOutboundMessage } from "@kirimail/db";
import * as schema from "@kirimail/db/schema";
import { buildRawMessage } from "@kirimail/mail";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted + vi.mock: the factory runs before module-import hoisting, so
// the fn reference must be declared inside vi.hoisted to be in scope when
// the factory executes. Without this the factory throws TDZ on mockSmtpSend.
const { mockSmtpSend } = vi.hoisted(() => ({
  mockSmtpSend: vi.fn<(...args: unknown[]) => Promise<SmtpSendResult>>(),
}));
vi.mock("../../caches", () => ({
  smtpCache: { send: mockSmtpSend, closeAll: vi.fn() },
  imapCache: { closeAll: vi.fn(), execute: vi.fn() },
  closeCachedConnections: vi.fn(),
}));

// eslint-disable-next-line import/first -- import must follow the vi.mock() above
import { handleSendMessage } from "../send-message";

type Db = NodePgDatabase<typeof schema>;

let db: Db;
let pool: Pool;
let senderAccountId: string;
let smtpIdentityId: string;

const FIRST_ATTEMPT = { retryCount: 0, retryLimit: 3 };

beforeAll(() => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  mockSmtpSend.mockReset();

  await db.delete(schema.outboundMessages);
  await db.delete(schema.smtpIdentities);
  await db.delete(schema.emailAccounts);
  await db.delete(schema.users);

  const senderUserId = await createTestUser(db);
  senderAccountId = await createEncryptedEmailAccount(db, senderUserId, {
    emailUser: "smtpsender",
  });
  smtpIdentityId = await createEncryptedSmtpIdentity(db, senderAccountId);
});

async function seedPendingRow() {
  const { raw, messageId, envelope } = await buildRawMessage({
    from: { name: null, address: "smtpsender@localhost" },
    to: [{ name: null, address: "smtprecipient@localhost" }],
    subject: "Unit test",
    text: "body",
  });
  const row = await insertOutboundMessage(db, {
    emailAccountId: senderAccountId,
    smtpIdentityId,
    rawMime: raw,
    messageId,
    envelopeFrom: envelope.from,
    envelopeTo: envelope.to,
  });
  if (!row) throw new Error("insertOutboundMessage returned undefined");
  return { rowId: row.id, messageId };
}

/** Minimal PgBoss double exposing just `send`, which is all the handler uses. */
function fakeBoss(sendImpl?: (name: string) => Promise<string | null>): {
  boss: PgBoss;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(sendImpl ?? (async () => "job-id"));
  return { boss: { send } as unknown as PgBoss, send };
}

describe("send-message handler (unit)", () => {
  it("marks the row failed with 'recipient' when SMTP resolves with zero accepted addresses", async () => {
    // Defensive branch: conforming SMTP servers don't produce this, and
    // nodemailer typically throws EENVELOPE. The guard protects against
    // nodemailer-version drift resolving with accepted=[].
    mockSmtpSend.mockResolvedValueOnce({
      accepted: [],
      rejected: ["ghost@example.com"],
      messageId: "<unit-zero-accepted@test.local>",
      response: "250 OK",
    });
    const { rowId } = await seedPendingRow();
    const { boss, send } = fakeBoss();

    await expect(
      handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT),
    ).resolves.toBeUndefined();

    const row = await getOutboundMessageById(db, rowId);
    expect(row?.status).toBe("failed");
    expect(row?.lastErrorCategory).toBe("recipient");
    expect(row?.lastError).toContain("ghost@example.com");
    // No append-sent enqueue on a failed row.
    expect(send).not.toHaveBeenCalled();
  });

  it("persists rejectedRecipients on the sent row when SMTP reports partial acceptance", async () => {
    // Integration can't easily produce partial DATA rejection via Stalwart.
    // This pins that the handler wires `result.rejected` into markSent so
    // the Outbox can distinguish full from partial delivery downstream.
    mockSmtpSend.mockResolvedValueOnce({
      accepted: ["smtprecipient@localhost"],
      rejected: ["dropped@example.com", "closed@example.net"],
      messageId: "<unit-partial@test.local>",
      response: "250 OK",
    });
    const { rowId, messageId } = await seedPendingRow();
    const { boss, send } = fakeBoss();

    await handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT);

    const row = await getOutboundMessageById(db, rowId);
    expect(row?.status).toBe("sent");
    expect(row?.rejectedRecipients).toEqual(["dropped@example.com", "closed@example.net"]);
    // append-sent still enqueued - partial delivery is "sent" for the
    // accepted set, so the Sent-folder copy path runs as usual.
    expect(send).toHaveBeenCalledWith(
      "append-sent",
      { outboundMessageId: rowId },
      { singletonKey: messageId },
    );
  });

  it("catches and logs when append-sent enqueue throws after a successful send", async () => {
    // Pins the documented catch-and-log contract for the enqueue gap. A
    // regression that rethrew here would trigger a pg-boss retry, which
    // would early-return on `status='sent'` and leak the row to the 6h
    // reaper without the Sent-folder copy landing.
    mockSmtpSend.mockResolvedValueOnce({
      accepted: ["smtprecipient@localhost"],
      rejected: [],
      messageId: "<unit-enqueue-fail@test.local>",
      response: "250 OK",
    });
    const { rowId } = await seedPendingRow();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { boss } = fakeBoss(async () => {
      throw new Error("simulated pg-boss insert failure");
    });

    // No throw propagates - that's the contract.
    await expect(
      handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT),
    ).resolves.toBeUndefined();

    // markSent committed before the failing enqueue; the row is at `sent`.
    const row = await getOutboundMessageById(db, rowId);
    expect(row?.status).toBe("sent");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("append-sent enqueue FAILED"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
