import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { createTestDb } from "#test/helpers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as schema from "../../schema";
import type { InsertDomainEventInput } from "../domain-event";

import { generateId } from "../../id";
import { domainEventConsumers, domainEvents } from "../../schema";
import {
  insertDomainEvent,
  insertDomainEvents,
  listUnconsumedDomainEvents,
  markDomainEventConsumed,
  markDomainEventFailed,
  MAX_CONSECUTIVE_FAILURES,
} from "../domain-event";

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
  // FK cascade on domain_event_consumers takes care of the child table.
  await db.delete(domainEvents);
});

function buildInput(overrides?: Partial<InsertDomainEventInput>): InsertDomainEventInput {
  return {
    aggregateType: "message",
    aggregateId: "msg-abc",
    eventType: "message.synced",
    ...overrides,
  };
}

/**
 * Insert events with explicit monotonically-increasing createdAt stamps
 * and return the inserted rows in the same order. Use this when a test
 * asserts a specific ordering - bypasses `defaultNow()` so the test
 * doesn't rely on microsecond-precision timestamps being distinct
 * across sequential awaits.
 */
async function seedEventsInOrder(
  inputs: Partial<InsertDomainEventInput>[],
): Promise<(typeof domainEvents.$inferSelect)[]> {
  const base = new Date("2025-01-01T00:00:00.000Z").getTime();
  return db
    .insert(domainEvents)
    .values(
      inputs.map((overrides, i) => ({
        id: generateId(),
        ...buildInput(overrides),
        createdAt: new Date(base + i * 1000),
      })),
    )
    .returning();
}

describe("domain-event repository", () => {
  it("defaults payload to an empty object when omitted on insert", async () => {
    // Pins the contract between the optional `InsertDomainEventInput.payload`
    // (TS-side) and the NOT NULL `payload` column (DB-side). The schema
    // default fills the gap when `{ ...input }` spreads an undefined
    // `payload`; dropping the default or changing that spread semantic
    // would start failing producers that legitimately omit the field.
    const row = await insertDomainEvent(db, buildInput());
    expect(row!.payload).toEqual({});
  });

  it("round-trips a non-empty payload unchanged", async () => {
    // Complements the `{}`-default test - producers will emit richer
    // payloads (rules actions, webhook data). Pins the jsonb round-trip
    // and the spread contract (value passes through when provided).
    const payload = { foo: "bar", nested: { n: 1, arr: [1, 2, 3] } };
    const inserted = await insertDomainEvent(db, { ...buildInput(), payload });
    expect(inserted!.payload).toEqual(payload);

    const [fetched] = await db.select().from(domainEvents).where(eq(domainEvents.id, inserted!.id));
    expect(fetched!.payload).toEqual(payload);
  });

  it("insertDomainEvents short-circuits on an empty input without issuing SQL", async () => {
    // Future producers that hand this function the RETURNING set of a
    // conflict-aware insert will pass an empty array whenever the
    // insert yields zero new rows. Postgres rejects INSERT with an
    // empty VALUES clause, so the primitive must short-circuit rather
    // than relying on the caller to branch.
    const inserted = await insertDomainEvents(db, []);
    expect(inserted).toEqual([]);

    const rows = await db.select().from(domainEvents);
    expect(rows).toHaveLength(0);
  });

  it("insertDomainEvents assigns a distinct id to every row in a batch", async () => {
    // Redundant with the PK today, but asserts the product contract
    // directly - a future composite-PK change that leaves `id`
    // non-unique would be caught here.
    const inputs = [
      buildInput({ aggregateId: "msg-1" }),
      buildInput({ aggregateId: "msg-2" }),
      buildInput({ aggregateId: "msg-3" }),
    ];
    const inserted = await insertDomainEvents(db, inputs);
    expect(inserted).toHaveLength(3);
    expect(new Set(inserted.map((r) => r.id)).size).toBe(3);
  });

  describe("listUnconsumedDomainEvents", () => {
    it("returns events the consumer has never seen, oldest-first, up to batchSize", async () => {
      // Pins the dispatcher's contract: ordered, bounded, and scoped to
      // a single consumer. Flipping the order or dropping the LIMIT
      // would silently break indexing throughput and ordering
      // guarantees downstream.
      const [a, b, c] = await seedEventsInOrder([
        { aggregateId: "msg-a" },
        { aggregateId: "msg-b" },
        { aggregateId: "msg-c" },
      ]);

      const batch = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        2,
      );
      expect(batch.map((e) => e.id)).toEqual([a!.id, b!.id]);

      const full = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(full.map((e) => e.id)).toEqual([a!.id, b!.id, c!.id]);
    });

    it("excludes events the consumer has marked consumed", async () => {
      const a = await insertDomainEvent(db, buildInput({ aggregateId: "msg-a" }));
      const b = await insertDomainEvent(db, buildInput({ aggregateId: "msg-b" }));

      await markDomainEventConsumed(db, a!.id, "meilisearch-indexer");

      const batch = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(batch.map((e) => e.id)).toEqual([b!.id]);
    });

    it("re-offers events whose last attempt failed (last_consumed_at still NULL)", async () => {
      // Failure leaves last_consumed_at NULL so the dispatcher picks the
      // event up again on its next tick - at-least-once is the
      // recovery model for idempotent consumers. If
      // `markDomainEventFailed` ever stamped last_consumed_at, retry would
      // silently stop.
      const a = await insertDomainEvent(db, buildInput());
      await markDomainEventFailed(db, a!.id, "meilisearch-indexer", "network hiccup");

      const batch = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(batch.map((e) => e.id)).toEqual([a!.id]);
    });

    it("tracks two consumers independently - one's progress does not hide events from the other", async () => {
      // This is the entire point of the two-table shape. If the
      // dispatcher ever scanned without the consumer_name filter, the
      // rules engine (v0.1.3) and meilisearch-indexer would race and
      // steal events from each other.
      const a = await insertDomainEvent(db, buildInput({ aggregateId: "msg-a" }));
      const b = await insertDomainEvent(db, buildInput({ aggregateId: "msg-b" }));

      await markDomainEventConsumed(db, a!.id, "meilisearch-indexer");

      const indexerBatch = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(indexerBatch.map((e) => e.id)).toEqual([b!.id]);

      const rulesBatch = await listUnconsumedDomainEvents(
        db,
        "rules-engine",
        ["message.synced"],
        10,
      );
      expect(rulesBatch.map((e) => e.id)).toEqual([a!.id, b!.id]);
    });

    it("breaks created_at ties by id to keep ordering deterministic", async () => {
      // The JSDoc on listUnconsumedDomainEvents explicitly promises
      // a secondary sort on `id` for same-microsecond events. A
      // future refactor that drops the `id` tiebreak (thinking it is
      // decorative) would silently reintroduce flaky ordering on
      // real-world clock collisions. Insert two events with an
      // identical explicit `createdAt` and assert the list returns
      // them in id-sorted order regardless of insertion order.
      const id1 = generateId();
      const id2 = generateId();
      // Use the database's own collation to determine order, not JS string comparison.
      // JS `<` uses code-point order; PostgreSQL's collation may differ (e.g. en_US.utf8
      // treats upper and lowercase as the same letter for primary sort).
      const { rows } = await db.execute<{ id1_first: boolean }>(
        sql`SELECT (${id1} < ${id2}) AS id1_first`,
      );
      const id1First = rows[0]!.id1_first;
      const smallerId = id1First ? id1 : id2;
      const largerId = id1First ? id2 : id1;
      const tiedTimestamp = new Date("2025-06-01T00:00:00.000Z");

      await db.insert(domainEvents).values([
        {
          id: largerId,
          ...buildInput({ aggregateId: "tie-larger-id-first" }),
          createdAt: tiedTimestamp,
        },
        {
          id: smallerId,
          ...buildInput({ aggregateId: "tie-smaller-id-second" }),
          createdAt: tiedTimestamp,
        },
      ]);

      const batch = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(batch.map((e) => e.id)).toEqual([smallerId, largerId]);
    });

    it("filters out events whose consecutive_failures has reached the threshold", async () => {
      // Poison-event isolation. Without this, a contiguous run of
      // failing events at the head of the queue eats every batch
      // forever and starves healthy events behind them.
      //
      // Seed five events ordered by createdAt; push the last two
      // to MAX_CONSECUTIVE_FAILURES and assert the scan returns
      // only the first three.
      const events = await seedEventsInOrder([
        { aggregateId: "msg-0" },
        { aggregateId: "msg-1" },
        { aggregateId: "msg-2" },
        { aggregateId: "msg-3" },
        { aggregateId: "msg-4" },
      ]);
      for (const poisonId of [events[3]!.id, events[4]!.id]) {
        for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
          await markDomainEventFailed(db, poisonId, "meilisearch-indexer", "boom");
        }
      }

      const batch = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(batch.map((e) => e.id)).toEqual([events[0]!.id, events[1]!.id, events[2]!.id]);
    });

    it("isolates poison events per consumer - one consumer's threshold doesn't hide the event from another", async () => {
      // The threshold filter joins on `consumer_name` via the LEFT
      // JOIN, so isolation must scope to (event, consumer) - not just
      // event. Production scenario: the meilisearch-indexer chokes on
      // a malformed event 5 times and gets isolated. Later, the rules
      // engine ships (v0.1.3) and starts processing message events
      // for the first time. It must still see this event, because
      // it has no prior failures recorded for itself. If isolation
      // ever leaked across consumers, a new consumer would inherit
      // every other consumer's poison list on first boot.
      const event = await insertDomainEvent(db, buildInput());
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "boom");
      }

      const indexerBatch = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(indexerBatch.map((e) => e.id)).toEqual([]);

      const rulesBatch = await listUnconsumedDomainEvents(
        db,
        "rules-engine",
        ["message.synced"],
        10,
      );
      expect(rulesBatch.map((e) => e.id)).toEqual([event!.id]);
    });

    it("re-offers an isolated event after an operator resets consecutive_failures", async () => {
      // Recovery path documented on MAX_CONSECUTIVE_FAILURES. Once
      // an event reaches the threshold, the operator fixes the
      // underlying cause and runs:
      //   UPDATE domain_event_consumers SET consecutive_failures = 0
      //   WHERE event_id = $1 AND consumer_name = $2;
      // The row's last_consumed_at stays NULL (it was never
      // successfully processed), so the scan offers the event again
      // on its next call. If the filter ever shifted to use a
      // different signal (e.g. attempts), this manual unblock would
      // silently stop working and "isolation" would mean "permanent
      // drop" instead of "pause until fixed".
      const event = await insertDomainEvent(db, buildInput());
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "boom");
      }

      const isolated = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(isolated.map((e) => e.id)).toEqual([]);

      await db
        .update(domainEventConsumers)
        .set({ consecutiveFailures: 0 })
        .where(
          and(
            eq(domainEventConsumers.eventId, event!.id),
            eq(domainEventConsumers.consumerName, "meilisearch-indexer"),
          ),
        );

      const reoffered = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(reoffered.map((e) => e.id)).toEqual([event!.id]);
    });

    it("filters out events whose eventType is outside the allowlist", async () => {
      // Pins the point of the `eventTypes` allowlist: a consumer that
      // only knows how to handle `message.synced` must never be handed
      // events from other domains (future tag / rule events), or its
      // dispatcher would mark them failed on every tick.
      //
      // `DomainEventType` is a single-literal TS union today, so the raw
      // SQL insert below forges a second value - the typed repository
      // API can't express one yet.
      const wantedId = generateId();
      const otherId = generateId();
      await db.execute(sql`
        INSERT INTO domain_events (id, aggregate_type, aggregate_id, event_type, payload, created_at)
        VALUES
          (${wantedId}, 'message', 'msg-wanted', 'message.synced', '{}'::jsonb, '2025-01-01T00:00:00Z'),
          (${otherId}, 'message', 'msg-other', 'tag.applied', '{}'::jsonb, '2025-01-01T00:00:01Z')
      `);

      const batch = await listUnconsumedDomainEvents(
        db,
        "meilisearch-indexer",
        ["message.synced"],
        10,
      );
      expect(batch.map((e) => e.id)).toEqual([wantedId]);
    });
  });

  describe("markDomainEventConsumed", () => {
    it("creates the progress row on the first call (no prior attempt)", async () => {
      // The progress row is created lazily - a successful first attempt
      // must go through the INSERT path of the upsert, not assume a
      // row exists.
      const event = await insertDomainEvent(db, buildInput());
      const row = await markDomainEventConsumed(db, event!.id, "meilisearch-indexer");

      expect(row).toBeDefined();
      expect(row!.lastConsumedAt).toBeInstanceOf(Date);
      expect(row!.lastError).toBeNull();
      expect(row!.attempts).toBe(1);
    });

    it("increments attempts and clears last_error after a prior failure", async () => {
      // Success after a recorded failure: the row must reflect the
      // new success (last_consumed_at stamped, error cleared) and carry
      // the full attempt count so an ops view shows the total work
      // the consumer did.
      const event = await insertDomainEvent(db, buildInput());
      await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "transient");

      const row = await markDomainEventConsumed(db, event!.id, "meilisearch-indexer");
      expect(row!.lastConsumedAt).toBeInstanceOf(Date);
      expect(row!.lastError).toBeNull();
      expect(row!.attempts).toBe(2);
    });

    it("resets consecutive_failures to 0 after a streak of failures", async () => {
      // The whole point of the counter: once a consumer succeeds, the
      // event is no longer poison and must become visible to scans
      // again. If the upsert's UPDATE branch ever stopped writing the
      // reset (e.g. someone "optimizes" by dropping the field from the
      // SET clause because attempts already covers it), an
      // operator-recovered event would stay invisible forever.
      const event = await insertDomainEvent(db, buildInput());
      await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "one");
      await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "two");
      const beforeConsume = await markDomainEventFailed(
        db,
        event!.id,
        "meilisearch-indexer",
        "three",
      );
      expect(beforeConsume!.consecutiveFailures).toBe(3);

      const consumed = await markDomainEventConsumed(db, event!.id, "meilisearch-indexer");
      expect(consumed!.consecutiveFailures).toBe(0);
    });

    it("is idempotent across repeat calls on an already-consumed row", async () => {
      // At-least-once means the dispatcher may re-fire consume on an
      // already-processed event (pg-boss infra retries after handler
      // success, stale workers). Repeat consume must re-stamp, bump
      // attempts, and not error.
      const event = await insertDomainEvent(db, buildInput());
      const first = await markDomainEventConsumed(db, event!.id, "meilisearch-indexer");
      const second = await markDomainEventConsumed(db, event!.id, "meilisearch-indexer");

      expect(second!.lastConsumedAt).toBeInstanceOf(Date);
      expect(second!.lastConsumedAt!.getTime()).toBeGreaterThanOrEqual(
        first!.lastConsumedAt!.getTime(),
      );
      expect(second!.lastError).toBeNull();
      expect(second!.attempts).toBe(2);
    });
  });

  describe("markDomainEventFailed", () => {
    it("leaves last_consumed_at NULL and stamps the error on first attempt", async () => {
      const event = await insertDomainEvent(db, buildInput());
      const row = await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "boom");

      expect(row!.lastConsumedAt).toBeNull();
      expect(row!.lastError).toBe("boom");
      expect(row!.attempts).toBe(1);
    });

    it("truncates oversized error payloads at 1 KiB", async () => {
      // Pins the repo-layer ceiling so a pathological upstream error
      // can't balloon the stored row (and, by extension, any ops
      // view). The truncation mirrors outbound_messages.last_error.
      const event = await insertDomainEvent(db, buildInput());
      const huge = "x".repeat(4096);

      const row = await markDomainEventFailed(db, event!.id, "meilisearch-indexer", huge);
      expect(row!.lastError!.length).toBeLessThanOrEqual(1024);
      expect(row!.lastError!.endsWith("...")).toBe(true);
    });

    it("starts consecutive_failures at 1 on first failure and bumps by 1 each retry", async () => {
      // Pins the counter that drives poison-event isolation. attempts
      // and consecutiveFailures move together during a failure streak,
      // but they're separate columns - the UPDATE SET clause must
      // increment both. A future refactor that aliased one to the other
      // would silently break the threshold filter.
      const event = await insertDomainEvent(db, buildInput());
      const first = await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "one");
      expect(first!.consecutiveFailures).toBe(1);
      expect(first!.attempts).toBe(1);

      const second = await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "two");
      expect(second!.consecutiveFailures).toBe(2);
      expect(second!.attempts).toBe(2);
    });

    it("overwrites the error on a subsequent failure and bumps attempts", async () => {
      // last_error is current state, not history. An ops view
      // showing a stale reason from two retries ago would be worse
      // than showing nothing.
      const event = await insertDomainEvent(db, buildInput());
      await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "first");
      const row = await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "second");

      expect(row!.lastError).toBe("second");
      expect(row!.attempts).toBe(2);
    });

    it("refreshes updatedAt on every retry, not just the first attempt", async () => {
      // Pins that Drizzle runs our `$onUpdate` column hook on the
      // `INSERT ... ON CONFLICT DO UPDATE` path, not just on plain
      // `.update()` calls. If a future Drizzle upgrade stopped running
      // the hook here, `updatedAt` would freeze at the first attempt
      // and the schema's "timestamp of the last attempt" invariant
      // would silently break. Two failed writes with a small sleep
      // between them must produce strictly increasing timestamps.
      const event = await insertDomainEvent(db, buildInput());
      const first = await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "one");
      await new Promise((r) => setTimeout(r, 5));
      const second = await markDomainEventFailed(db, event!.id, "meilisearch-indexer", "two");

      expect(second!.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime());
    });

    it("rejects an already-consumed row (resurrection guard)", async () => {
      // A late failure report from a slow worker must not un-consume
      // a row that another attempt has already succeeded on. The
      // UPDATE is gated on `lastConsumedAt IS NULL`, returns
      // `undefined`, and must leave every column untouched:
      //   - `lastConsumedAt` / `lastError` / `attempts`: a half-
      //     applied UPDATE would corrupt the consumed state.
      //   - `updatedAt`: a refactor that weakened the SET clause to a
      //     no-op but still ran the UPDATE would let `$onUpdate` stamp
      //     a fresh timestamp, looking like "something happened" on
      //     the ops view when nothing did.
      //   - `consecutiveFailures`: with the poison counter, a stale
      //     failure that slipped past the guard could push a healthy
      //     event across the threshold post-hoc and re-isolate it on
      //     a later tick.
      const event = await insertDomainEvent(db, buildInput());
      const consumed = await markDomainEventConsumed(db, event!.id, "meilisearch-indexer");

      const rejected = await markDomainEventFailed(
        db,
        event!.id,
        "meilisearch-indexer",
        "late failure report",
      );
      expect(rejected).toBeUndefined();

      const [row] = await db
        .select()
        .from(domainEventConsumers)
        .where(
          and(
            eq(domainEventConsumers.eventId, event!.id),
            eq(domainEventConsumers.consumerName, "meilisearch-indexer"),
          ),
        );
      expect(row!.lastConsumedAt).toEqual(consumed!.lastConsumedAt);
      expect(row!.lastError).toBeNull();
      expect(row!.attempts).toBe(1);
      expect(row!.consecutiveFailures).toBe(0);
      expect(row!.updatedAt.getTime()).toBe(consumed!.updatedAt.getTime());
    });
  });

  it("cascades domain_event_consumers rows when the parent domain_events row is deleted", async () => {
    // Protects the ON DELETE CASCADE declaration. Future retention
    // sweeps will delete events; their per-consumer progress rows
    // must go with them without a bespoke cleanup step.
    const event = await insertDomainEvent(db, buildInput());
    await markDomainEventConsumed(db, event!.id, "meilisearch-indexer");

    await db.delete(domainEvents).where(eq(domainEvents.id, event!.id));

    const survivors = await db
      .select()
      .from(domainEventConsumers)
      .where(
        and(
          eq(domainEventConsumers.eventId, event!.id),
          eq(domainEventConsumers.consumerName, "meilisearch-indexer"),
        ),
      );
    expect(survivors).toHaveLength(0);
  });
});
