import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  cleanImapState,
  createEncryptedEmailAccount,
  createEncryptedSmtpIdentity,
  createTestDb,
  createTestUser,
  seedSentMailbox,
} from "#test/helpers";
import {
  getOutboundMessageById,
  insertOutboundMessage,
  markPendingOutboundMessageSending,
} from "@kirimail/db";
import * as schema from "@kirimail/db/schema";
import { buildRawMessage, encryptCredential, serializeEnvelope } from "@kirimail/mail";
import { testCredentials, withImapConnection } from "@kirimail/mail/testing";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAppendSent, registerSendMessage } from "..";
import { handleSendMessage } from "../send-message";

type Db = NodePgDatabase<typeof schema>;

let db: Db;
let pool: Pool;
let senderUserId: string;
let senderAccountId: string;
let smtpIdentityId: string;

const senderCreds = () => testCredentials("smtpsender");
const recipientCreds = () => testCredentials("smtprecipient");

beforeAll(() => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Reverse FK order, then users.
  await db.delete(schema.outboundMessages);
  await db.delete(schema.smtpIdentities);
  await db.delete(schema.messages);
  await db.delete(schema.mailboxes);
  await db.delete(schema.emailAccounts);
  await db.delete(schema.users);

  await Promise.all([cleanImapState(senderCreds()), cleanImapState(recipientCreds())]);

  senderUserId = await createTestUser(db);
  senderAccountId = await createEncryptedEmailAccount(db, senderUserId, {
    emailUser: "smtpsender",
  });
  smtpIdentityId = await createEncryptedSmtpIdentity(db, senderAccountId);

  // Recipient account exists so the IMAP read-back helper can authenticate.
  const recipientUserId = await createTestUser(db);
  await createEncryptedEmailAccount(db, recipientUserId, {
    emailUser: "smtprecipient",
  });
});

// ---------------------------------------------------------------------------
// Helpers
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

interface SeedRowOptions {
  to?: string[];
  subject?: string;
  inReplyTo?: string;
  references?: string;
}

/** Build real MIME via buildRawMessage and insert an outbound_messages row. */
async function seedOutboundRow(
  overrides?: SeedRowOptions & { smtpIdentity?: string; emailAccount?: string },
) {
  const to = overrides?.to ?? ["smtprecipient@localhost"];
  const { raw, messageId, envelope } = await buildRawMessage({
    from: { name: null, address: "smtpsender@localhost" },
    to: to.map((address) => ({ name: null, address })),
    subject: overrides?.subject ?? "Test subject",
    text: "Integration test body.",
    inReplyTo: overrides?.inReplyTo,
    references: overrides?.references,
  });
  const row = await insertOutboundMessage(db, {
    emailAccountId: overrides?.emailAccount ?? senderAccountId,
    smtpIdentityId: overrides?.smtpIdentity ?? smtpIdentityId,
    rawMime: raw,
    messageId,
    envelopeFrom: envelope.from,
    envelopeTo: envelope.to,
  });
  if (!row) throw new Error("insertOutboundMessage returned undefined");
  return { rowId: row.id, messageId, raw };
}

interface ReadBackMessage {
  subject?: string;
  to?: string;
  inReplyTo?: string;
  references?: string;
  flags: Set<string>;
}

async function readMailbox(user: string, mailbox: string): Promise<ReadBackMessage[]> {
  return withImapConnection(testCredentials(user), async (client) => {
    const status = await client.status(mailbox, { messages: true });
    if (!status.messages || status.messages === 0) return [];

    const lock = await client.getMailboxLock(mailbox);
    try {
      const msgs: ReadBackMessage[] = [];
      for await (const msg of client.fetch("1:*", {
        envelope: true,
        flags: true,
        headers: ["in-reply-to", "references"],
      })) {
        const headers = msg.headers
          ? Object.fromEntries(
              msg.headers
                .toString()
                .split(/\r?\n(?!\s)/)
                .filter(Boolean)
                .map((line) => {
                  const idx = line.indexOf(":");
                  if (idx === -1) return [line.toLowerCase().trim(), ""];
                  return [line.slice(0, idx).toLowerCase().trim(), line.slice(idx + 1).trim()];
                }),
            )
          : {};

        msgs.push({
          subject: msg.envelope?.subject ?? undefined,
          to: msg.envelope?.to?.[0]?.address ?? undefined,
          inReplyTo: headers["in-reply-to"],
          references: headers["references"],
          flags: msg.flags ?? new Set(),
        });
      }
      return msgs;
    } finally {
      lock.release();
    }
  });
}

// Attempt metadata used by direct handler invocations. The registration
// wrapper reads these off pg-boss's JobWithMetadata in production; the
// test shortcut lets us exercise the non-final vs final branches without
// needing pg-boss to drive real retries.
const FIRST_ATTEMPT = { retryCount: 0, retryLimit: 3 };
const FINAL_ATTEMPT = { retryCount: 3, retryLimit: 3 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("send-message via pg-boss", () => {
  it("sends via SMTP, marks sent, and enqueues append-sent with the messageId as singletonKey", async () => {
    await seedSentMailbox(db, senderAccountId, senderCreds());
    const { rowId, messageId } = await seedOutboundRow({ subject: "Happy path" });

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerAppendSent(boss);
      await registerSendMessage(boss);
      const sendSpy = boss.getSpy("send-message");
      const appendSpy = boss.getSpy("append-sent");

      await boss.send("send-message", { outboundMessageId: rowId });
      await sendSpy.waitForJob(() => true, "completed");

      const inbox = await readMailbox("smtprecipient", "INBOX");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.subject).toBe("Happy path");

      const sentRow = await getOutboundMessageById(db, rowId);
      expect(sentRow?.status).toBe("sent");
      // Full acceptance -> empty rejected list on the row.
      expect(sentRow?.rejectedRecipients).toEqual([]);

      // append-sent job was enqueued with the expected singletonKey.
      // Runs the handler end-to-end so the Sent-folder APPEND and
      // row deletion complete before we assert.
      const appendJob = await appendSpy.waitForJob(() => true, "completed");
      expect(appendJob.data).toMatchObject({ outboundMessageId: rowId });
      // SpyJob strips metadata (singletonKey / retry counters / timestamps);
      // fetch the persisted row to assert the key landed correctly.
      const appendMeta = await boss.getJobById("append-sent", appendJob.id);
      expect(appendMeta?.singletonKey).toBe(messageId);

      // Row deleted by append-sent's last-consumer cleanup.
      expect(await getOutboundMessageById(db, rowId)).toBeUndefined();

      const sent = await readMailbox("smtpsender", "Sent");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toBe("Happy path");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("deletes the row directly when appendToSent is false and enqueues no append-sent job", async () => {
    // Replace default identity with one that has appendToSent=false.
    await db.delete(schema.smtpIdentities);
    smtpIdentityId = await createEncryptedSmtpIdentity(db, senderAccountId, {
      appendToSent: false,
    });

    const { rowId } = await seedOutboundRow({ subject: "No sent copy" });

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerAppendSent(boss);
      await registerSendMessage(boss);
      const sendSpy = boss.getSpy("send-message");
      const appendSpy = boss.getSpy("append-sent");

      await boss.send("send-message", { outboundMessageId: rowId });
      await sendSpy.waitForJob(() => true, "completed");

      // Row deleted by the send-message handler itself (no append-sent step).
      expect(await getOutboundMessageById(db, rowId)).toBeUndefined();

      // Recipient got the message.
      const inbox = await readMailbox("smtprecipient", "INBOX");
      expect(inbox).toHaveLength(1);

      // No append-sent job ever enqueued. Poll negatively for a short window.
      const sawAppendJob = await Promise.race([
        appendSpy
          .waitForJob(() => true, "completed")
          .then(() => true)
          .catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(sawAppendJob).toBe(false);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("marks the row failed with auth category and does not throw when credentials are wrong", async () => {
    // Replace identity with one whose password doesn't match the Stalwart principal.
    await db.delete(schema.smtpIdentities);
    smtpIdentityId = await createEncryptedSmtpIdentity(db, senderAccountId, {
      smtpPassword: "wrong-password",
    });
    const { rowId } = await seedOutboundRow({ subject: "Auth failure" });

    const boss = createTestBoss();
    await boss.start();
    try {
      // Call the handler directly so we can assert the no-throw contract
      // without round-tripping through pg-boss's retry machinery.
      await expect(
        handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT),
      ).resolves.toBeUndefined();

      const row = await getOutboundMessageById(db, rowId);
      expect(row?.status).toBe("failed");
      expect(row?.lastErrorCategory).toBe("auth");
      expect(row?.attempts).toBe(1); // markPendingSending fires before SMTP rejects
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("resets the row to pending and throws on a transient network error", async () => {
    // Point the identity at a closed port. Nodemailer surfaces ECONNREFUSED
    // which classifySmtpError maps to "transient".
    await db.delete(schema.smtpIdentities);
    smtpIdentityId = await createEncryptedSmtpIdentity(db, senderAccountId, {
      smtpHost: "127.0.0.1",
      smtpPort: 59999,
    });
    const { rowId } = await seedOutboundRow({ subject: "Transient failure" });

    const boss = createTestBoss();
    await boss.start();
    try {
      // Direct call: assert the throw propagates so pg-boss drives backoff.
      await expect(
        handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT),
      ).rejects.toThrow();

      const row = await getOutboundMessageById(db, rowId);
      expect(row?.status).toBe("pending");
      expect(row?.lastErrorCategory).toBe("transient");
      expect(row?.lastError).toBeTruthy();
      // attempts bumped once by markPendingSending before the throw reset the status.
      expect(row?.attempts).toBe(1);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("still resets to pending on a transient failure at the attempt before the budget exhausts", async () => {
    // Pins the `>=` boundary from below: with retryCount=2 and retryLimit=3,
    // one retry remains in the budget, so the handler must still reset-and-
    // throw. A regression to `>` would terminalize prematurely here, and the
    // existing `retryCount === retryLimit` test wouldn't catch that because
    // both predicates agree at equality.
    await db.delete(schema.smtpIdentities);
    smtpIdentityId = await createEncryptedSmtpIdentity(db, senderAccountId, {
      smtpHost: "127.0.0.1",
      smtpPort: 59999,
    });
    const { rowId } = await seedOutboundRow({ subject: "Second-to-last attempt" });

    const boss = createTestBoss();
    await boss.start();
    try {
      await expect(
        handleSendMessage(boss, { outboundMessageId: rowId }, { retryCount: 2, retryLimit: 3 }),
      ).rejects.toThrow();

      const row = await getOutboundMessageById(db, rowId);
      expect(row?.status).toBe("pending");
      expect(row?.lastErrorCategory).toBe("transient");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("terminalizes a transient failure on the final allowed attempt instead of resetting to pending", async () => {
    // Without this branch, the final transient failure would reset the row
    // to `pending` — but pg-boss wouldn't retry again, so the row would be
    // orphaned with no retry queued and no `failed` surface for the Outbox
    // to render. The handler must preserve the `transient` category on the
    // terminal row so the UI can frame it accurately; the transition is
    // about lifecycle (we stopped trying), not error class.
    await db.delete(schema.smtpIdentities);
    smtpIdentityId = await createEncryptedSmtpIdentity(db, senderAccountId, {
      smtpHost: "127.0.0.1",
      smtpPort: 59999,
    });
    const { rowId } = await seedOutboundRow({ subject: "Retry exhaustion" });

    const boss = createTestBoss();
    await boss.start();
    try {
      // No throw on the final attempt — we return after markFailed so pg-boss
      // records the job as completed rather than bouncing it through another
      // no-op retry cycle.
      await expect(
        handleSendMessage(boss, { outboundMessageId: rowId }, FINAL_ATTEMPT),
      ).resolves.toBeUndefined();

      const row = await getOutboundMessageById(db, rowId);
      expect(row?.status).toBe("failed");
      expect(row?.lastErrorCategory).toBe("transient");
      expect(row?.lastError).toBeTruthy();
      // markPendingSending still fired; attempts reflects the invocation count,
      // not pg-boss's retry counter.
      expect(row?.attempts).toBe(1);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("marks the row failed with recipient category when Stalwart rejects the RCPT", async () => {
    // Stalwart's [session.rcpt] directory rejects addresses not registered in
    // the memory directory. `unknown@localhost` is not a principal, so the
    // server responds 550 at RCPT TO -> classifySmtpError -> "recipient".
    const { rowId } = await seedOutboundRow({
      to: ["unknown@localhost"],
      subject: "Unknown recipient",
    });

    const boss = createTestBoss();
    await boss.start();
    try {
      await expect(
        handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT),
      ).resolves.toBeUndefined();

      const row = await getOutboundMessageById(db, rowId);
      expect(row?.status).toBe("failed");
      // Nodemailer may classify this as "recipient" (EENVELOPE / 550). If
      // Stalwart ever defers the rejection past RCPT to DATA, the category
      // would become "protocol" (generic 5xx). Both are deterministic
      // non-retriable branches; pin on "recipient" which is the expected path
      // for a DIRECTORY-enforced RCPT rejection.
      expect(row?.lastErrorCategory).toBe("recipient");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("stamps precondition on cred-decrypt failure and is idempotent on repeat invocation", async () => {
    // Re-encrypt the identity's password with a key that's not the test key.
    // resolveSmtpCredentials will throw on decrypt — a local precondition
    // failure, not an SMTP-server rejection. Repeat-invocation assertions
    // codify the concurrent-race invariant from the handler's pre-dispatch
    // block comment: deterministic inputs produce identical outcomes, and
    // the second call early-returns on the terminal state rather than
    // re-attempting. Sequential repeat stands in for concurrent interleave;
    // idempotence of outcome is the property, not real parallelism.
    const wrongKey = Buffer.from(
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      "hex",
    );
    const badEnvelope = encryptCredential("testpass", wrongKey, 1);
    await db
      .update(schema.smtpIdentities)
      .set({ encryptedPassword: serializeEnvelope(badEnvelope) })
      .where(eq(schema.smtpIdentities.id, smtpIdentityId));

    const { rowId } = await seedOutboundRow({ subject: "Cred decrypt" });

    const boss = createTestBoss();
    await boss.start();
    try {
      await handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT);
      const first = await getOutboundMessageById(db, rowId);
      expect(first?.status).toBe("failed");
      expect(first?.lastErrorCategory).toBe("precondition");
      // Pre-dispatch failure never entered markPendingSending; attempts
      // stays at 0 so operators can distinguish "never tried" from "tried
      // and rejected".
      expect(first?.attempts).toBe(0);

      // Second call: row already `failed`, must early-return at the status
      // check rather than attempt another markFailed. No transitions.
      await expect(
        handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT),
      ).resolves.toBeUndefined();
      const second = await getOutboundMessageById(db, rowId);
      expect(second?.status).toBe("failed");
      expect(second?.attempts).toBe(0);
      expect(second?.lastError).toBe(first?.lastError);
      expect(second?.updatedAt.getTime()).toBe(first!.updatedAt.getTime());
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("returns cleanly when the row is not in pending (race with another worker)", async () => {
    // Construct the race by advancing the row to `sending` before invoking
    // the handler. The handler must return without throwing and without
    // bumping attempts again.
    const { rowId } = await seedOutboundRow({ subject: "Race" });
    await markPendingOutboundMessageSending(db, rowId);
    const beforeAttempts = (await getOutboundMessageById(db, rowId))!.attempts;

    const boss = createTestBoss();
    await boss.start();
    try {
      await expect(
        handleSendMessage(boss, { outboundMessageId: rowId }, FIRST_ATTEMPT),
      ).resolves.toBeUndefined();

      const row = await getOutboundMessageById(db, rowId);
      expect(row?.status).toBe("sending"); // untouched
      expect(row?.attempts).toBe(beforeAttempts);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });

  it("returns cleanly when the row no longer exists", async () => {
    const boss = createTestBoss();
    await boss.start();
    try {
      // Console spy to confirm the not-found branch ran (defensive — the
      // benign skip path must not blow up on a randomly enqueued ID).
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(
        handleSendMessage(boss, { outboundMessageId: randomUUID() }, FIRST_ATTEMPT),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
