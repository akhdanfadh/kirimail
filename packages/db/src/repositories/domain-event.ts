/**
 * Read and write helpers for {@link domainEvents} and {@link domainEventConsumers}.
 *
 * Delivery is at-least-once: a consumer may be offered the same event
 * more than once. This file has no "give up on this event" state and no
 * reaper - callers re-offer failed events on their own schedule. Every
 * consumer must therefore be idempotent (running it twice on the same
 * event lands on the same final state).
 *
 * Tenant-agnostic: no `userId` / `accountId` parameters here. The API
 * layer is responsible for scoping reads and writes to the right user.
 *
 * Vocabulary: a "tick" is one dispatcher poll cycle - the loop that
 * pulls a batch via {@link listUnconsumedDomainEvents}, processes it,
 * then marks each event consumed or failed.
 */

import type { DomainAggregateType, DomainEventType } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type * as schema from "../schema";

import { generateId } from "../id";
import { domainEventConsumers, domainEvents } from "../schema";

type Db = NodePgDatabase<typeof schema>;

/** 1 KiB fits the head of a realistic stack trace or error message without bloating the row. */
const MAX_LAST_ERROR_LENGTH = 1024;
const TRUNCATION_SUFFIX = "...";

function truncateErrorMessage(msg: string): string {
  if (msg.length <= MAX_LAST_ERROR_LENGTH) return msg;
  return msg.slice(0, MAX_LAST_ERROR_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/** Input accepted by {@link insertDomainEvent} and {@link insertDomainEvents}. */
export interface InsertDomainEventInput {
  aggregateType: DomainAggregateType;
  aggregateId: string;
  eventType: DomainEventType;
  /** Optional extra data. Defaults to `{}` at the schema layer. */
  payload?: Record<string, unknown>;
}

/** Insert a single domain event row. */
export async function insertDomainEvent(db: Db, input: InsertDomainEventInput) {
  const [row] = await db
    .insert(domainEvents)
    .values({ id: generateId(), ...input })
    .returning();
  return row;
}

/**
 * Insert many domain events in one statement.
 * Returns `[]` without issuing SQL when `inputs` is empty.
 */
export async function insertDomainEvents(db: Db, inputs: InsertDomainEventInput[]) {
  // Postgres rejects `INSERT` with no `VALUES`, so we can't just let drizzle
  // run on an empty array. Producers that pipe in the `RETURNING` rows of an
  // `INSERT ... ON CONFLICT DO NOTHING` get zero rows whenever every value
  // collided; short-circuiting here saves them from branching.
  if (inputs.length === 0) return [];
  const rows = inputs.map((input) => ({ id: generateId(), ...input }));
  return db.insert(domainEvents).values(rows).returning();
}

/**
 * Return the oldest events in `eventTypes` that `consumerName` hasn't
 * successfully processed yet, up to `batchSize`. An event counts as
 * unconsumed when its `domain_event_consumers` row is missing or has
 * `last_consumed_at IS NULL` (last attempt failed).
 *
 * Pass exactly the event types your consumer's `switch` handles. A
 * wider allowlist breaks the moment a new event type lands in another
 * domain: the consumer's `switch` would throw on those rows and the
 * dispatcher would re-fail them on every tick.
 *
 * Not safe to call concurrently on its own: the SELECT takes no row
 * locks, so two parallel calls can return the same events.
 *
 * Order: `created_at` first, then `id` as a tiebreaker - two events
 * written in the same microsecond would otherwise flip order between calls.
 */
export async function listUnconsumedDomainEvents(
  db: Db,
  consumerName: string,
  eventTypes: readonly DomainEventType[],
  batchSize: number,
) {
  return (
    db
      // NOTE: no row-level locking on this SELECT. Two dispatchers running at
      // the same time could otherwise fetch the same events and both process
      // them, wasting work. We prevent that via pg-boss's `policy: "stately"`
      // on the consumer's queue - it runs at most one handler invocation at
      // a time, so two ticks never overlap. This only holds as long as we run
      // a single pg-boss instance. If we ever run several against the same DB,
      // wrap `list + mark` in a transaction with `FOR UPDATE SKIP LOCKED`,
      // or switch to a reserve-then-process pattern (each tick stamps a
      // `claimed_at`; a separate job sweeps claims that have gone stale).
      .select({
        id: domainEvents.id,
        aggregateType: domainEvents.aggregateType,
        aggregateId: domainEvents.aggregateId,
        eventType: domainEvents.eventType,
        payload: domainEvents.payload,
        createdAt: domainEvents.createdAt,
      })
      .from(domainEvents)
      .leftJoin(
        domainEventConsumers,
        and(
          eq(domainEventConsumers.eventId, domainEvents.id),
          eq(domainEventConsumers.consumerName, consumerName),
        ),
      )
      // NOTE: Cost grows with the total number of events, not the backlog -
      // the `domain_events` scan is ordered by `created_at` and doesn't cut
      // off at the caller's progress. Revisit when this call exceeds ~50ms or
      // the table passes ~1M rows without retention. Fix is a per-consumer
      // cursor table: one row per consumer holding the last-dispatched
      // `created_at`, so the query becomes `WHERE created_at > cursor` and
      // only scans what hasn't been handled yet.
      .where(
        and(
          inArray(domainEvents.eventType, eventTypes),
          or(isNull(domainEventConsumers.eventId), isNull(domainEventConsumers.lastConsumedAt)),
        ),
      )
      // NOTE: The tiebreak on `id` is stable between calls but not causal.
      // `id` is a random nanoid, so ties sort in nanoid order, not insertion
      // order - fine for idempotent consumers (they just need stable pagination).
      // If a consumer ever needs true causal order within one batch,
      // swap `id` for a time-sortable id type like ULID.
      .orderBy(domainEvents.createdAt, domainEvents.id)
      .limit(batchSize)
  );
}

/**
 * Record that `consumerName` successfully processed `eventId`.
 *
 * Uses an upsert. Both paths set `lastConsumedAt` to now, clear
 * `lastError`, and bump `attempts`, so a success that follows
 * earlier failures still ends with the right attempt count.
 */
export async function markDomainEventConsumed(db: Db, eventId: string, consumerName: string) {
  const now = new Date();
  const [row] = await db
    .insert(domainEventConsumers)
    .values({
      eventId,
      consumerName,
      lastConsumedAt: now,
      lastError: null,
      attempts: 1,
    })
    // No `where` guard: success is terminal under at-least-once delivery ("success wins").
    // A retry that succeeds after a prior failure always overwrites the failed state.
    // Contrast with `markDomainEventFailed`, whose UPDATE IS guarded so a late failure
    // report can't un-consume an already-successful event.
    .onConflictDoUpdate({
      target: [domainEventConsumers.eventId, domainEventConsumers.consumerName],
      set: {
        lastConsumedAt: now,
        lastError: null,
        attempts: sql`${domainEventConsumers.attempts} + 1`,
      },
    })
    .returning();
  return row;
}

/**
 * Record that `consumerName` failed to process `eventId`.
 *
 * Uses an upsert. Writes the truncated `error`, bumps `attempts`,
 * and leaves `lastConsumedAt` NULL so {@link listUnconsumedDomainEvents}
 * offers this event again on the next tick.
 *
 * Guarded against "un-consuming" a success: if the row is already
 * consumed, the UPDATE is skipped and the function returns `undefined`.
 * This covers the race where a slow worker reports failure AFTER
 * another attempt has already succeeded. Callers treat `undefined`
 * as "a later attempt already won."
 */
export async function markDomainEventFailed(
  db: Db,
  eventId: string,
  consumerName: string,
  error: string,
) {
  const truncated = truncateErrorMessage(error);
  const [row] = await db
    .insert(domainEventConsumers)
    .values({
      eventId,
      consumerName,
      lastConsumedAt: null,
      lastError: truncated,
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: [domainEventConsumers.eventId, domainEventConsumers.consumerName],
      set: {
        lastConsumedAt: null,
        lastError: truncated,
        attempts: sql`${domainEventConsumers.attempts} + 1`,
      },
      where: isNull(domainEventConsumers.lastConsumedAt),
    })
    .returning();
  return row;
}
