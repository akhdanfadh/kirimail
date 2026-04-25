import type { Meilisearch } from "@kirimail/search";
import type { AttachmentMetadata, MessageAddress } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  cleanImapState,
  createEncryptedEmailAccount,
  createTestDb,
  createTestMeiliClient,
  createTestUser,
  ensureTestMeilisearchConfig,
  resetTestIndex,
  TEST_INDEX_UID,
} from "#test/helpers";
import { insertDomainEvent, markDomainEventConsumed, MAX_CONSECUTIVE_FAILURES } from "@kirimail/db";
import * as schema from "@kirimail/db/schema";
import { testCredentials, seedMessage } from "@kirimail/mail/testing";
import {
  getMessageDoc,
  MeilisearchApiError,
  MeilisearchError,
  MeilisearchRequestError,
} from "@kirimail/search";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registerEventDispatcher, registerSyncEmailAccount } from "..";
import {
  EVENT_DISPATCHER_QUEUE,
  handleEventDispatcher,
  MEILISEARCH_CONSUMER_NAME,
} from "../event-dispatcher";

type Db = NodePgDatabase<typeof schema>;

/** Default batch size for tests. Individual tests override (e.g. the drain test uses 2). */
const TEST_BATCH_SIZE = 100;

let db: Db;
let pool: Pool;
let meili: Meilisearch;

beforeAll(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
  meili = createTestMeiliClient();
  await ensureTestMeilisearchConfig(meili);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Reverse FK order, then users.
  await db.delete(schema.domainEventConsumers);
  await db.delete(schema.domainEvents);
  await db.delete(schema.messages);
  await db.delete(schema.mailboxes);
  await db.delete(schema.emailAccounts);
  await db.delete(schema.users);

  await resetTestIndex(meili);
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedMessageInput {
  subject?: string;
  from?: MessageAddress[];
  to?: MessageAddress[];
  cc?: MessageAddress[];
  bcc?: MessageAddress[];
  flags?: string[];
  attachments?: AttachmentMetadata[];
}

/**
 * Insert a user + email account + mailbox + message row in one go.
 * Returns the IDs so tests can build a `domain_events` row pointing at
 * a real message.
 */
async function seedMessageRow(input: SeedMessageInput = {}): Promise<{
  messageId: string;
  mailboxId: string;
  emailAccountId: string;
  userId: string;
}> {
  const userId = await createTestUser(db);
  const emailAccountId = await createEncryptedEmailAccount(db, userId);
  const mailboxId = randomUUID();
  await db.insert(schema.mailboxes).values({
    id: mailboxId,
    emailAccountId,
    path: "INBOX",
    role: "inbox",
  });

  const messageId = randomUUID();
  await db.insert(schema.messages).values({
    id: messageId,
    mailboxId,
    providerUid: 1,
    uidValidity: 1,
    subject: input.subject ?? "Test subject",
    fromAddress: input.from ?? [{ name: "Alice", address: "alice@example.com" }],
    toAddress: input.to ?? [{ name: "Bob", address: "bob@example.com" }],
    ccAddress: input.cc ?? [],
    bccAddress: input.bcc ?? [],
    flags: input.flags ?? ["\\Seen"],
    attachments: input.attachments ?? [],
    internalDate: new Date("2026-01-01T00:00:00Z"),
    sizeOctets: 1234,
  });

  return { messageId, mailboxId, emailAccountId, userId };
}

async function seedSyncedEvent(messageId: string): Promise<string> {
  const row = await insertDomainEvent(db, {
    aggregateType: "message",
    aggregateId: messageId,
    eventType: "message.synced",
  });
  return row!.id;
}

async function consumerRow(eventId: string) {
  const [row] = await db
    .select()
    .from(schema.domainEventConsumers)
    .where(
      and(
        eq(schema.domainEventConsumers.eventId, eventId),
        eq(schema.domainEventConsumers.consumerName, MEILISEARCH_CONSUMER_NAME),
      ),
    )
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Mock Meilisearch clients for error-path scenarios
// ---------------------------------------------------------------------------

/**
 * Real client, but throws `MeilisearchApiError` for one specific message id;
 * all other calls pass through. Used to test that one bad event doesn't
 * break the rest of the batch.
 */
function meiliWithPoison(real: Meilisearch, poisonId: string): Meilisearch {
  return {
    index(uid: string) {
      const realIndex = real.index(uid);
      return new Proxy(realIndex, {
        get(target, prop, receiver) {
          if (prop === "updateDocuments") {
            return (docs: unknown[]) => {
              if (Array.isArray(docs) && docs.some((d) => (d as { id: string }).id === poisonId)) {
                throw new MeilisearchApiError(
                  new Response(null, { status: 400, statusText: "Bad Request" }),
                  {
                    message: `poisoned ${poisonId}`,
                    code: "invalid_document_fields",
                    type: "invalid_request",
                    link: "",
                  },
                );
              }
              return (target as { updateDocuments: (d: unknown[]) => unknown }).updateDocuments(
                docs,
              );
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  } as unknown as Meilisearch;
}

/** Client whose every `updateDocuments` call fails with a network error. */
function meiliAllInfraDown(): Meilisearch {
  const failingIndex = {
    updateDocuments: () => {
      throw new MeilisearchRequestError("http://unreachable", new Error("ECONNREFUSED"));
    },
  };
  return {
    index: () => failingIndex,
  } as unknown as Meilisearch;
}

/** Client that throws `MeilisearchApiError` for every event. Used to test the all-poison case where no event makes progress. */
function meiliAllPoison(): Meilisearch {
  const failingIndex = {
    updateDocuments: () => {
      throw new MeilisearchApiError(
        new Response(null, { status: 400, statusText: "Bad Request" }),
        {
          message: "all-poison",
          code: "invalid_document_fields",
          type: "invalid_request",
          link: "",
        },
      );
    },
  };
  return {
    index: () => failingIndex,
  } as unknown as Meilisearch;
}

/**
 * Made-up `MeilisearchError` subclass to simulate a future SDK release adding
 * a new error type the dispatcher doesn't recognize.
 */
class UnknownMeilisearchError extends MeilisearchError {
  override name = "UnknownMeilisearchError";
}

/** Client whose every `updateDocuments` call throws {@link UnknownMeilisearchError}. */
function meiliUnknownErrorClass(): Meilisearch {
  const failingIndex = {
    updateDocuments: () => {
      throw new UnknownMeilisearchError("unknown error subclass");
    },
  };
  return {
    index: () => failingIndex,
  } as unknown as Meilisearch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleEventDispatcher (direct invocation)", () => {
  it("indexes headers + attachments and marks the event consumed", async () => {
    const attachments: AttachmentMetadata[] = [
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 4096,
        contentId: null,
        disposition: "attachment",
        partPath: "2",
      },
    ];
    const { messageId, mailboxId, emailAccountId, userId } = await seedMessageRow({
      subject: "Hello",
      attachments,
    });
    const eventId = await seedSyncedEvent(messageId);

    await handleEventDispatcher({
      db,
      meili,
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });

    const doc = await getMessageDoc(meili, messageId, TEST_INDEX_UID);
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(messageId);
    expect(doc!.userId).toBe(userId);
    expect(doc!.emailAccountId).toBe(emailAccountId);
    expect(doc!.mailboxId).toBe(mailboxId);
    expect(doc!.subject).toBe("Hello");
    expect(doc!.from).toEqual(["Alice <alice@example.com>"]);
    expect(doc!.to).toEqual(["Bob <bob@example.com>"]);
    expect(doc!.cc).toEqual([]);
    expect(doc!.bcc).toEqual([]);
    expect(doc!.flags).toEqual(["\\Seen"]);
    expect(doc!.sizeBytes).toBe(1234);
    expect(doc!.receivedDate).toBe(Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000));
    expect(doc!.attachments).toEqual(attachments);
    expect(doc!.encrypted).toBe(false);

    const consumer = await consumerRow(eventId);
    expect(consumer?.lastConsumedAt).toBeInstanceOf(Date);
    expect(consumer?.lastError).toBeNull();
    expect(consumer?.attempts).toBe(1);
  });

  it("formats nameless and group-syntax addresses correctly", async () => {
    const { messageId } = await seedMessageRow({
      from: [{ name: null, address: "solo@example.com" }],
      to: [
        { name: "Group", address: null }, // RFC 2822 group-syntax sentinel - skip
        { name: "Keep", address: "keep@example.com" },
      ],
    });
    await seedSyncedEvent(messageId);

    await handleEventDispatcher({
      db,
      meili,
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });

    const doc = await getMessageDoc(meili, messageId, TEST_INDEX_UID);
    expect(doc!.from).toEqual(["<solo@example.com>"]);
    expect(doc!.to).toEqual(["Keep <keep@example.com>"]);
  });

  it("isolates a MeilisearchApiError to the one event, batch continues", async () => {
    const poison = await seedMessageRow({ subject: "Poison" });
    const healthy = await seedMessageRow({ subject: "Healthy" });
    const poisonEventId = await seedSyncedEvent(poison.messageId);
    const healthyEventId = await seedSyncedEvent(healthy.messageId);

    const poisoning = meiliWithPoison(meili, poison.messageId);
    await handleEventDispatcher({
      db,
      meili: poisoning,
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });

    const poisonConsumer = await consumerRow(poisonEventId);
    expect(poisonConsumer?.lastConsumedAt).toBeNull();
    expect(poisonConsumer?.lastError).toMatch(/poisoned/);
    expect(poisonConsumer?.attempts).toBe(1);

    const healthyConsumer = await consumerRow(healthyEventId);
    expect(healthyConsumer?.lastConsumedAt).toBeInstanceOf(Date);
    expect(healthyConsumer?.lastError).toBeNull();

    // Healthy doc indexed; poison doc absent.
    expect(await getMessageDoc(meili, healthy.messageId, TEST_INDEX_UID)).not.toBeNull();
    expect(await getMessageDoc(meili, poison.messageId, TEST_INDEX_UID)).toBeNull();
  });

  it("returns the consumed / failed split for the wrapper to branch on", async () => {
    // 2 healthy + 1 poison. The wrapper's self-enqueue gate reads these
    // counts, so the result shape needs to be exact.
    const healthyA = await seedMessageRow({ subject: "Count-A" });
    const healthyB = await seedMessageRow({ subject: "Count-B" });
    const poison = await seedMessageRow({ subject: "Count-Poison" });
    await seedSyncedEvent(healthyA.messageId);
    await seedSyncedEvent(healthyB.messageId);
    await seedSyncedEvent(poison.messageId);

    const result = await handleEventDispatcher({
      db,
      meili: meiliWithPoison(meili, poison.messageId),
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });
    expect(result).toEqual({ consumed: 2, failed: 1, skipped: 0 });
  });

  it("returns consumed=0 under an all-poison batch so the wrapper's hot-loop guard holds", async () => {
    // Pins the negative half of the wrapper's self-enqueue gate. Without
    // `consumed === 0` here, an all-failing batch would self-enqueue
    // forever, hot-looping on the same failures every tick. The positive
    // half (full batch + progress -> self-enqueue) is covered by the
    // backlog-drain test below.
    const poisonBatch = 5;
    for (let i = 0; i < poisonBatch; i++) {
      const { messageId } = await seedMessageRow({ subject: `Poison-${i}` });
      await seedSyncedEvent(messageId);
    }

    const result = await handleEventDispatcher({
      db,
      meili: meiliAllPoison(),
      indexUid: TEST_INDEX_UID,
      batchSize: poisonBatch,
    });
    expect(result).toEqual({ consumed: 0, failed: poisonBatch, skipped: 0 });
  });

  it("warns once when a poison event reaches MAX_CONSECUTIVE_FAILURES", async () => {
    // Operator-facing signal that an event is now invisible to the
    // scan - the only one-shot signal in v0.1.x. If the dispatcher's
    // `=== MAX_CONSECUTIVE_FAILURES` check ever drifts (typo, wrong
    // constant, accidentally compared against `attempts`), poison
    // events would sit invisible with no operator alert.
    const { messageId } = await seedMessageRow();
    const eventId = await seedSyncedEvent(messageId);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boundaryPattern = new RegExp(
      `event ${eventId}.*reached consecutive_failures=${MAX_CONSECUTIVE_FAILURES}`,
    );

    try {
      for (let tick = 1; tick <= MAX_CONSECUTIVE_FAILURES; tick++) {
        await handleEventDispatcher({
          db,
          meili: meiliAllPoison(),
          indexUid: TEST_INDEX_UID,
          batchSize: TEST_BATCH_SIZE,
        });
      }

      const boundaryWarns = warnSpy.mock.calls.filter((args) =>
        boundaryPattern.test(String(args[0] ?? "")),
      );
      expect(boundaryWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("treats unknown MeilisearchError subclasses as per-event, not infra", async () => {
    // Safety net for SDK upgrades. If a future meilisearch version adds
    // an error class we haven't whitelisted as infra, the dispatcher
    // should warn and treat it as per-event (markFailed + continue), not
    // rethrow as if it were infra and abort the tick.
    const { messageId } = await seedMessageRow();
    const eventId = await seedSyncedEvent(messageId);

    const result = await handleEventDispatcher({
      db,
      meili: meiliUnknownErrorClass(),
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });
    expect(result).toEqual({ consumed: 0, failed: 1, skipped: 0 });

    const consumer = await consumerRow(eventId);
    expect(consumer?.lastConsumedAt).toBeNull();
    expect(consumer?.lastError).toMatch(/unknown error subclass/);
    expect(consumer?.attempts).toBe(1);
  });

  it("rethrows Meilisearch infra errors without marking events failed", async () => {
    const { messageId } = await seedMessageRow();
    const eventId = await seedSyncedEvent(messageId);

    await expect(
      handleEventDispatcher({
        db,
        meili: meiliAllInfraDown(),
        indexUid: TEST_INDEX_UID,
        batchSize: TEST_BATCH_SIZE,
      }),
    ).rejects.toBeInstanceOf(MeilisearchRequestError);

    // No consumer row was created - the event stays unconsumed and the
    // next trigger will retry. The "re-offer until consumed" property is
    // tested at the repo layer; here we only assert the dispatcher
    // doesn't write anything on the failure path.
    expect(await consumerRow(eventId)).toBeUndefined();
  });

  it("skips already-consumed events on re-dispatch (crash-resume)", async () => {
    const ids: string[] = [];
    const eventIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { messageId } = await seedMessageRow({ subject: `CR-${i}` });
      ids.push(messageId);
      eventIds.push(await seedSyncedEvent(messageId));
    }

    // Pretend-consume the first event without actually indexing; the next
    // run must process only the remaining two, and the first event's
    // attempts must stay at 1 (the dispatcher should not re-mark it).
    await markDomainEventConsumed(db, eventIds[0]!, MEILISEARCH_CONSUMER_NAME);

    await handleEventDispatcher({
      db,
      meili,
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });

    // Pre-consumed: indexing was skipped (we pretended it was consumed); doc absent.
    expect(await getMessageDoc(meili, ids[0]!, TEST_INDEX_UID)).toBeNull();
    // Fresh: indexed in this run.
    expect(await getMessageDoc(meili, ids[1]!, TEST_INDEX_UID)).not.toBeNull();
    expect(await getMessageDoc(meili, ids[2]!, TEST_INDEX_UID)).not.toBeNull();

    // Attempts: pre-consumed row stayed at 1 (no re-process), freshly
    // processed rows are at 1 too (first successful pass).
    for (const eventId of eventIds) {
      const c = await consumerRow(eventId);
      expect(c?.attempts).toBe(1);
      expect(c?.lastConsumedAt).toBeInstanceOf(Date);
    }
  });

  it("marks event consumed when the aggregate row is gone (idempotent no-op)", async () => {
    const nonexistentMessageId = `msg_${randomUUID()}`;
    const row = await insertDomainEvent(db, {
      aggregateType: "message",
      aggregateId: nonexistentMessageId,
      eventType: "message.synced",
    });

    await handleEventDispatcher({
      db,
      meili,
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });

    const consumer = await consumerRow(row!.id);
    expect(consumer?.lastConsumedAt).toBeInstanceOf(Date);
    expect(consumer?.lastError).toBeNull();
    expect(await getMessageDoc(meili, nonexistentMessageId, TEST_INDEX_UID)).toBeNull();
  });

  it("counts skipped (not failed) when markDomainEventFailed loses the resurrection race", async () => {
    // Race scenario: another actor (here: a stub mid-upsert) consumes
    // the event before the dispatcher's catch path runs markFailed. The
    // markFailed UPDATE is guarded by `WHERE last_consumed_at IS NULL`
    // and no-ops, returning undefined. The dispatcher must count this
    // as `skipped` (not `failed`) because no error was actually written
    // to the consumer row.
    //
    // Doesn't happen in normal operation (stately + SKIP LOCKED prevents
    // concurrent ticks), but the branch exists for the edge cases listed
    // on the dispatcher's `skipped++` site. We exercise it here so the
    // branch isn't quietly broken.
    const { messageId } = await seedMessageRow({ subject: "Race target" });
    const eventId = await seedSyncedEvent(messageId);

    // Mock `EnqueuedTaskPromise`: `updateDocuments` returns a thenable
    // that also exposes `.waitTask()`, because `awaitTaskOrThrow` drives
    // the work through `.waitTask` (not by awaiting the outer return).
    //
    // BRITTLE: this mock encodes the contract of `awaitTaskOrThrow` (see
    // packages/search/src/tasks.ts). If that primitive switches to a
    // different shape (e.g. polling getTask off `client.tasks`), this
    // test silently stops exercising the race. Update both sites
    // together when refactoring task-await.
    const racingMeili = {
      index() {
        return {
          updateDocuments: () => {
            const enqueued = Object.assign(Promise.resolve(), {
              async waitTask() {
                // Race: consume the event row before the dispatcher's catch
                // path runs `markDomainEventFailed`. The failure UPDATE then
                // hits the `WHERE last_consumed_at IS NULL` guard and skips.
                await markDomainEventConsumed(db, eventId, MEILISEARCH_CONSUMER_NAME);
                throw new MeilisearchApiError(
                  new Response(null, { status: 400, statusText: "Bad Request" }),
                  {
                    message: "fail-after-race",
                    code: "invalid_document_fields",
                    type: "invalid_request",
                    link: "",
                  },
                );
              },
            });
            return enqueued;
          },
        };
      },
    } as unknown as Meilisearch;

    const result = await handleEventDispatcher({
      db,
      meili: racingMeili,
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });
    expect(result).toEqual({ consumed: 0, failed: 0, skipped: 1 });

    // Consumer row reflects the racing markConsumed (not the dispatcher's
    // no-op markFailed): lastConsumedAt set, lastError clean, attempts=1.
    const consumer = await consumerRow(eventId);
    expect(consumer?.lastConsumedAt).toBeInstanceOf(Date);
    expect(consumer?.lastError).toBeNull();
    expect(consumer?.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Post-sync trigger: end-to-end via pg-boss
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

describe("event-dispatcher via pg-boss (post-sync trigger)", () => {
  // Dedicated principal so test files running in parallel against the shared
  // Stalwart container don't stomp each other's INBOX state.
  const dispatchCreds = () => testCredentials("dispatchuser");

  beforeEach(async () => {
    await cleanImapState(dispatchCreds());
  });

  it("indexes synced messages after sync completes, without waiting for the cron", async () => {
    const userId = await createTestUser(db);
    const accountId = await createEncryptedEmailAccount(db, userId, {
      emailUser: "dispatchuser",
    });

    // Seed a few messages on the IMAP server so sync has work to do.
    await seedMessage(dispatchCreds(), { headers: { subject: "Integration A" } });
    await seedMessage(dispatchCreds(), { headers: { subject: "Integration B" } });

    const boss = createTestBoss();
    await boss.start();
    try {
      // Order matters: dispatcher queue must exist before sync handler
      // tries to enqueue into it.
      await registerEventDispatcher(boss, { indexUid: TEST_INDEX_UID, batchSize: TEST_BATCH_SIZE });
      await registerSyncEmailAccount(boss);

      const syncSpy = boss.getSpy("sync-email-account");
      const dispatchSpy = boss.getSpy(EVENT_DISPATCHER_QUEUE);

      await boss.send(
        "sync-email-account",
        { emailAccountId: accountId },
        { singletonKey: accountId },
      );

      // Sync completes (messages land in Postgres + domain_events emitted).
      await syncSpy.waitForJob(() => true, "completed");

      // Post-sync trigger enqueued the dispatcher; wait for its tick to finish.
      await dispatchSpy.waitForJob(() => true, "completed");

      // Docs must now be in Meilisearch without the cron having fired.
      const msgRows = await db.select().from(schema.messages);
      expect(msgRows).toHaveLength(2);
      for (const row of msgRows) {
        const doc = await getMessageDoc(meili, row.id, TEST_INDEX_UID);
        expect(doc).not.toBeNull();
        expect(doc!.emailAccountId).toBe(accountId);
        expect(doc!.userId).toBe(userId);
      }

      // Every emitted event consumed.
      const events = await db.select().from(schema.domainEvents);
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (const event of events) {
        const c = await consumerRow(event.id);
        expect(c?.lastConsumedAt).toBeInstanceOf(Date);
      }
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});

describe("event-dispatcher via pg-boss (backlog drain)", () => {
  // No IMAP cleanup needed - this suite seeds events directly in Postgres.

  it("self-enqueues on a full batch to drain backlog without waiting for cron", async () => {
    // 3 events with batchSize=2: the first tick fills the batch and
    // triggers the self-enqueue path; the second tick drains the remainder.
    const seeded: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { messageId } = await seedMessageRow({ subject: `Drain-${i}` });
      seeded.push(messageId);
      await seedSyncedEvent(messageId);
    }

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerEventDispatcher(boss, { indexUid: TEST_INDEX_UID, batchSize: 2 });

      await boss.send(EVENT_DISPATCHER_QUEUE, {});

      // Poll until all 3 events are consumed. We can't use the spy's
      // waitForJob to await the second tick - it returns the same first
      // match every time, doesn't advance - so we just assert end-state
      // convergence (which is what "drained" means anyway).
      const deadline = Date.now() + 10_000;
      let consumedCount = 0;
      while (Date.now() < deadline) {
        const consumers = await db
          .select()
          .from(schema.domainEventConsumers)
          .where(eq(schema.domainEventConsumers.consumerName, MEILISEARCH_CONSUMER_NAME));
        consumedCount = consumers.filter((c) => c.lastConsumedAt !== null).length;
        if (consumedCount === 3) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(consumedCount).toBe(3);

      for (const id of seeded) {
        expect(await getMessageDoc(meili, id, TEST_INDEX_UID)).not.toBeNull();
      }
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
