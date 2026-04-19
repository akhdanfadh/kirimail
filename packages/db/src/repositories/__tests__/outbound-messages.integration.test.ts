import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  createTestDb,
  createTestEmailAccount,
  createTestSmtpIdentity,
  createTestUser,
} from "#test/helpers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as schema from "../../schema";
import type { InsertOutboundMessageInput } from "../outbound-messages";

import { emailAccounts, outboundMessages, smtpIdentities } from "../../schema";
import {
  deleteOutboundMessage,
  getOutboundMessageById,
  insertOutboundMessage,
  markOutboundMessageFailed,
  markPendingOutboundMessageSending,
  markSendingOutboundMessageSent,
  resetSendingOutboundMessageToPending,
  retryFailedOutboundMessage,
} from "../outbound-messages";

type Db = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

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
  // Scope cleanup to the table this file writes. Do not wipe shared parents
  // (emailAccounts, users) — cascade would hit mailbox tests running in
  // parallel against the same test container. Fresh generated IDs make
  // per-test accumulation harmless for our assertions.
  await db.delete(outboundMessages);

  userId = await createTestUser(db);
  accountId = await createTestEmailAccount(db, userId);
  smtpIdentityId = await createTestSmtpIdentity(db, accountId);
});

function buildInput(overrides?: Partial<InsertOutboundMessageInput>): InsertOutboundMessageInput {
  return {
    emailAccountId: accountId,
    smtpIdentityId,
    rawMime: Buffer.from("From: a@test.local\r\nTo: b@test.local\r\n\r\nhi"),
    messageId: "<test@kirimail.local>",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("outboundMessages repository", () => {
  it("preserves BYTEA bytes exactly across insert and read", async () => {
    // 2KB payload mixing nulls, high bits, and printable ASCII — the kind of
    // bytes a text-encoded column or a wrong driver mapping would corrupt.
    const payload = Buffer.alloc(2048);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i % 256;
    }

    const inserted = await insertOutboundMessage(db, buildInput({ rawMime: payload }));
    expect(inserted).toBeDefined();

    const fetched = await getOutboundMessageById(db, inserted!.id);
    expect(fetched).toBeDefined();
    expect(Buffer.isBuffer(fetched!.rawMime)).toBe(true);
    expect(fetched!.rawMime.equals(payload)).toBe(true);
  });

  it("walks the happy lifecycle pending -> sending -> sent", async () => {
    const inserted = await insertOutboundMessage(db, buildInput());
    expect(inserted!.status).toBe("pending");
    expect(inserted!.attempts).toBe(0);
    expect(inserted!.sentAt).toBeNull();

    const sending = await markPendingOutboundMessageSending(db, inserted!.id);
    expect(sending).toBeDefined();
    expect(sending!.status).toBe("sending");
    expect(sending!.attempts).toBe(1);

    const sent = await markSendingOutboundMessageSent(db, inserted!.id);
    expect(sent).toBeDefined();
    expect(sent!.status).toBe("sent");
    expect(sent!.sentAt).toBeInstanceOf(Date);
  });

  it("walks the failure lifecycle pending -> sending -> failed", async () => {
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);

    const failed = await markOutboundMessageFailed(
      db,
      inserted!.id,
      "auth",
      "535 authentication failed",
    );
    expect(failed).toBeDefined();
    expect(failed!.status).toBe("failed");
    expect(failed!.lastError).toBe("535 authentication failed");
    expect(failed!.lastErrorCategory).toBe("auth");
    expect(failed!.attempts).toBe(1);
    expect(failed!.sentAt).toBeNull();
  });

  it("clears lastError and lastErrorCategory when retried or eventually succeeded", async () => {
    // `lastError`/`lastErrorCategory` track current state, not history. A
    // retry-in-progress row must not advertise a resolved failure; a
    // successful send must not render alongside the stale reason of a
    // prior attempt.
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);
    await markOutboundMessageFailed(db, inserted!.id, "transient", "network hiccup");

    // Failed -> sending goes through the explicit admin-retry path,
    // not markSending (which is pending-only by design).
    const retrying = await retryFailedOutboundMessage(db, inserted!.id);
    expect(retrying!.status).toBe("sending");
    expect(retrying!.attempts).toBe(2);
    expect(retrying!.lastError).toBeNull();
    expect(retrying!.lastErrorCategory).toBeNull();

    const succeeded = await markSendingOutboundMessageSent(db, inserted!.id);
    expect(succeeded!.status).toBe("sent");
    expect(succeeded!.lastError).toBeNull();
    expect(succeeded!.lastErrorCategory).toBeNull();
  });

  it("supports transient-retry via resetSendingOutboundMessageToPending (pg-boss retry path)", async () => {
    // Worker sees a transient SMTP failure, stamps the error on the row
    // (so the UI can show "retrying: <reason>") and resets to pending so
    // pg-boss can re-fire. The next markSending accepts from pending,
    // bumps attempts, and clears the stamped error for the fresh attempt.
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);

    const reset = await resetSendingOutboundMessageToPending(
      db,
      inserted!.id,
      "transient",
      "ETIMEDOUT",
    );
    expect(reset).toBeDefined();
    expect(reset!.status).toBe("pending");
    // Error visible while the row waits for retry.
    expect(reset!.lastError).toBe("ETIMEDOUT");
    expect(reset!.lastErrorCategory).toBe("transient");

    const retrying = await markPendingOutboundMessageSending(db, inserted!.id);
    expect(retrying).toBeDefined();
    expect(retrying!.status).toBe("sending");
    expect(retrying!.attempts).toBe(2);
    // Fresh attempt clears the stamped error.
    expect(retrying!.lastError).toBeNull();
    expect(retrying!.lastErrorCategory).toBeNull();
  });

  it("rejects markOutboundMessageFailed on an already-sent row (resurrection guard)", async () => {
    // A delayed or duplicated worker that reports failure after another
    // worker has already marked the row `sent` must not flip the status
    // back to `failed` — the email has already been delivered.
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);
    await markSendingOutboundMessageSent(db, inserted!.id);

    const result = await markOutboundMessageFailed(
      db,
      inserted!.id,
      "transient",
      "late failure report",
    );
    expect(result).toBeUndefined();

    const [row] = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, inserted!.id));
    expect(row!.status).toBe("sent");
    expect(row!.lastError).toBeNull();
    expect(row!.lastErrorCategory).toBeNull();
  });

  it("markSending rejects failed rows — retryFailedOutboundMessage owns failed -> sending", async () => {
    // A buggy worker that throws after markFailed would trigger pg-boss to
    // retry and re-enter markSending. `failed` must be terminal for automatic
    // retry; explicit admin-initiated retry uses a distinct function.
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);
    await markOutboundMessageFailed(db, inserted!.id, "auth", "535 bad password");

    const autoRetry = await markPendingOutboundMessageSending(db, inserted!.id);
    expect(autoRetry).toBeUndefined();

    const adminRetry = await retryFailedOutboundMessage(db, inserted!.id);
    expect(adminRetry).toBeDefined();
    expect(adminRetry!.status).toBe("sending");
    expect(adminRetry!.attempts).toBe(2);
  });

  it("deleteOutboundMessage removes the row and returns the deleted id", async () => {
    // The last consumer (append worker on success, or send worker for
    // appendToSent=false) calls this on success. The row is gone; the
    // Sent-folder copy is the authoritative record going forward.
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);
    await markSendingOutboundMessageSent(db, inserted!.id);

    const deleted = await deleteOutboundMessage(db, inserted!.id);
    expect(deleted!.id).toBe(inserted!.id);

    const fetched = await getOutboundMessageById(db, inserted!.id);
    expect(fetched).toBeUndefined();

    // A second delete on the same id is a no-op, not a throw.
    const again = await deleteOutboundMessage(db, inserted!.id);
    expect(again).toBeUndefined();
  });

  it("markFailed rejects a failed row — no silent overwrite of lastError", async () => {
    // A delayed duplicate failure report must not trample the existing
    // error metadata on a row that's already failed. An explicit
    // "refresh failure reason" need would be a new, separately-named
    // helper; markFailed is strictly for pending|sending -> failed.
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);
    await markOutboundMessageFailed(db, inserted!.id, "auth", "535 bad password");

    const stale = await markOutboundMessageFailed(db, inserted!.id, "transient", "stale report");
    expect(stale).toBeUndefined();

    const [row] = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, inserted!.id));
    expect(row!.lastError).toBe("535 bad password");
    expect(row!.lastErrorCategory).toBe("auth");
  });

  it("serializes concurrent markPendingOutboundMessageSending — only one transition succeeds", async () => {
    // Two concurrent markSending calls race. Whatever the serialization
    // mechanism (row lock in Postgres, connection queueing in the pool,
    // or anything else), the observable property is what matters: exactly
    // one caller transitions the row and bumps attempts, the loser's
    // WHERE re-evaluates against the updated state and returns undefined.
    const inserted = await insertOutboundMessage(db, buildInput());

    const [a, b] = await Promise.all([
      markPendingOutboundMessageSending(db, inserted!.id),
      markPendingOutboundMessageSending(db, inserted!.id),
    ]);

    const winners = [a, b].filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.attempts).toBe(1);
  });

  it("serializes concurrent markSent vs markFailed — exactly one transition wins", async () => {
    // Worker A's success and worker B's late error reach the DB at the same
    // time. Whatever the serialization mechanism, exactly one UPDATE lands
    // and the other's guard rejects. No intermediate state where both
    // "succeed" from their own perspective; no row can be both sent and
    // failed.
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);

    const [sent, failed] = await Promise.all([
      markSendingOutboundMessageSent(db, inserted!.id),
      markOutboundMessageFailed(db, inserted!.id, "transient", "racing failure"),
    ]);

    const winners = [sent, failed].filter((row) => row !== undefined);
    expect(winners).toHaveLength(1);

    const [finalRow] = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, inserted!.id));
    if (sent !== undefined) {
      expect(finalRow!.status).toBe("sent");
      expect(finalRow!.lastError).toBeNull();
      expect(finalRow!.lastErrorCategory).toBeNull();
    } else {
      expect(finalRow!.status).toBe("failed");
      expect(finalRow!.lastError).toBe("racing failure");
      expect(finalRow!.lastErrorCategory).toBe("transient");
    }
  });

  it("rejects markPendingOutboundMessageSending on an already-sent row (double-dispatch guard)", async () => {
    const inserted = await insertOutboundMessage(db, buildInput());
    await markPendingOutboundMessageSending(db, inserted!.id);
    await markSendingOutboundMessageSent(db, inserted!.id);

    // A stale worker attempts to pick up the row after it was already delivered.
    // The guarded WHERE clause must reject the transition and leave state untouched.
    const result = await markPendingOutboundMessageSending(db, inserted!.id);
    expect(result).toBeUndefined();

    const [row] = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, inserted!.id));
    expect(row!.status).toBe("sent");
    expect(row!.attempts).toBe(1);
  });

  it("retryFailedOutboundMessage rejects non-failed rows — admin-retry is failed-only", async () => {
    // The guard is `status = 'failed'` specifically. Accepting `pending` would
    // silently bump attempts on a row the normal flow is about to pick up;
    // accepting `sending` would double-dispatch under a concurrent worker;
    // accepting `sent` would resurrect a delivered email into the send queue.
    const pendingRow = await insertOutboundMessage(
      db,
      buildInput({ messageId: "<retry-pending@kirimail.local>" }),
    );
    expect(await retryFailedOutboundMessage(db, pendingRow!.id)).toBeUndefined();

    const sendingRow = await insertOutboundMessage(
      db,
      buildInput({ messageId: "<retry-sending@kirimail.local>" }),
    );
    await markPendingOutboundMessageSending(db, sendingRow!.id);
    expect(await retryFailedOutboundMessage(db, sendingRow!.id)).toBeUndefined();

    const sentRow = await insertOutboundMessage(
      db,
      buildInput({ messageId: "<retry-sent@kirimail.local>" }),
    );
    await markPendingOutboundMessageSending(db, sentRow!.id);
    await markSendingOutboundMessageSent(db, sentRow!.id);
    expect(await retryFailedOutboundMessage(db, sentRow!.id)).toBeUndefined();
  });

  it("resetSendingOutboundMessageToPending rejects non-sending rows — no resurrection", async () => {
    // The guard is `status = 'sending'` specifically. Accepting `sent` would
    // resurrect a delivered email; accepting `failed` would bypass the
    // explicit admin-retry path; accepting `pending` would stamp a stale
    // error onto a row that isn't mid-retry.
    const pendingRow = await insertOutboundMessage(
      db,
      buildInput({ messageId: "<reset-pending@kirimail.local>" }),
    );
    expect(
      await resetSendingOutboundMessageToPending(db, pendingRow!.id, "transient", "spurious"),
    ).toBeUndefined();

    const failedRow = await insertOutboundMessage(
      db,
      buildInput({ messageId: "<reset-failed@kirimail.local>" }),
    );
    await markPendingOutboundMessageSending(db, failedRow!.id);
    await markOutboundMessageFailed(db, failedRow!.id, "auth", "535 bad password");
    expect(
      await resetSendingOutboundMessageToPending(db, failedRow!.id, "transient", "spurious"),
    ).toBeUndefined();
    // Stamped error from markFailed must not be overwritten by the rejected reset.
    const [failedAfter] = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, failedRow!.id));
    expect(failedAfter!.lastError).toBe("535 bad password");
    expect(failedAfter!.lastErrorCategory).toBe("auth");

    const sentRow = await insertOutboundMessage(
      db,
      buildInput({ messageId: "<reset-sent@kirimail.local>" }),
    );
    await markPendingOutboundMessageSending(db, sentRow!.id);
    await markSendingOutboundMessageSent(db, sentRow!.id);
    expect(
      await resetSendingOutboundMessageToPending(db, sentRow!.id, "transient", "spurious"),
    ).toBeUndefined();
  });

  it("rejects duplicate (emailAccountId, messageId) inserts", async () => {
    // Protects messageId as an idempotency key for the send API: a second
    // submit with the same Message-ID within the same account must fail
    // fast at the DB rather than creating a ghost pending row.
    await insertOutboundMessage(db, buildInput({ messageId: "<dup@kirimail.local>" }));

    await expect(
      insertOutboundMessage(db, buildInput({ messageId: "<dup@kirimail.local>" })),
    ).rejects.toThrow();
  });

  it("enforces the lastError / lastErrorCategory pair invariant at the DB", async () => {
    // Repo helpers always set or clear both fields together, but a CHECK
    // constraint guards against raw SQL and future helpers that forget
    // the pairing. Protects the declaration from being silently removed.
    const inserted = await insertOutboundMessage(db, buildInput());
    await expect(
      db
        .update(outboundMessages)
        .set({ lastError: "orphan", lastErrorCategory: null })
        .where(eq(outboundMessages.id, inserted!.id)),
    ).rejects.toThrow();
  });

  it("rejects empty rawMime via the non-empty CHECK constraint", async () => {
    // A zero-length MIME payload indicates a caller bug and nothing
    // downstream would accept it. Assert the specific pg `constraint`
    // name via the error cause so that if node-postgres ever encoded an
    // empty Buffer as NULL (hitting NOT NULL instead, SQLSTATE 23502),
    // the test would fail loudly rather than quietly still "passing"
    // for the wrong reason.
    try {
      await insertOutboundMessage(db, buildInput({ rawMime: Buffer.alloc(0) }));
      expect.fail("insert should have thrown");
    } catch (err) {
      const pgErr = (err as { cause?: { code?: string; constraint?: string } }).cause ?? err;
      expect((pgErr as { code?: string }).code).toBe("23514");
      expect((pgErr as { constraint?: string }).constraint).toBe(
        "outbound_messages_raw_mime_non_empty_chk",
      );
    }
  });

  it("cascades outbound messages when the parent email account is deleted", async () => {
    const inserted = await insertOutboundMessage(db, buildInput());

    await db.delete(emailAccounts).where(eq(emailAccounts.id, accountId));

    const fetched = await getOutboundMessageById(db, inserted!.id);
    expect(fetched).toBeUndefined();
  });

  it("restricts deletion of an SMTP identity while an outbound message references it", async () => {
    await insertOutboundMessage(db, buildInput());

    await expect(
      db.delete(smtpIdentities).where(eq(smtpIdentities.id, smtpIdentityId)),
    ).rejects.toThrow();
  });

  it("rejects outbound insert when the SMTP identity belongs to a different account", async () => {
    // Cross-tenant integrity: the identity must belong to the email account
    // on the same row. Column-level FKs alone would allow user A to send via
    // user B's identity if the API's ownership check were skipped; the
    // composite FK makes the DB the final guard.
    const otherUserId = await createTestUser(db);
    const otherAccountId = await createTestEmailAccount(db, otherUserId);
    const otherIdentityId = await createTestSmtpIdentity(db, otherAccountId);

    await expect(
      insertOutboundMessage(db, buildInput({ smtpIdentityId: otherIdentityId })),
    ).rejects.toThrow();
  });
});
