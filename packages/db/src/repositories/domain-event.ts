/**
 * Primitives for reading and mutating {@link domainEvents} and
 * {@link domainEventConsumers}.
 *
 * At-least-once is the contract: this file exposes no "terminally
 * failed" state and no reaper. Callers are expected to re-offer failed
 * events on their own schedule, so consumers must be idempotent -
 * re-processing must produce the same final state.
 *
 * Tenant-agnostic: no `userId` / `accountId` signatures.
 * Tenant scoping happens at the API layer.
 */

import type { DomainAggregateType, DomainEventType } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, isNull, or, sql } from "drizzle-orm";

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
 * Batch-insert domain events; empty input short-circuits without SQL.
 * Handles producers that pass the `RETURNING` set of a conflict-aware
 * insert and get back zero new rows.
 */
export async function insertDomainEvents(db: Db, inputs: InsertDomainEventInput[]) {
  if (inputs.length === 0) return [];
  const rows = inputs.map((input) => ({ id: generateId(), ...input }));
  return db.insert(domainEvents).values(rows).returning();
}

/**
 * Return oldest-first domain events that have not yet been consumed by
 * `consumerName`. An event is unconsumed for a given consumer when its
 * `domain_event_consumers` row is missing or has `last_consumed_at IS NULL`.
 *
 * Secondary sort on `id` pins ordering deterministically when two
 * events share the same `created_at` microsecond.
 *
 * NOTE: the `id` tiebreak is deterministic, not causal. `id` is a random
 * nanoid, so ties sort in nanoid order, not insertion order. Fine for
 * idempotent consumers (pagination stability is all they need). Revisit
 * with a time-sortable id (ULID, etc.) if a consumer needs causal order
 * within one batch.
 *
 * NOTE: No `FOR UPDATE SKIP LOCKED`. Exclusivity is delegated to
 * pg-boss via `singletonKey=consumerName, teamSize=1` - at most one
 * handler invocation per consumer runs at once. If that coordination
 * ever moves out of pg-boss, wrap `list + mark` in a transaction with
 * `FOR UPDATE SKIP LOCKED` or switch to a `claimed_at` reserve
 * pattern with stale-claim recovery.
 *
 * NOTE: the cost driver is the `domain_events` scan by `created_at`,
 * which grows with total event count rather than backlog. Revisit
 * when this call exceeds ~50ms or `domain_events` passes ~1M rows
 * without retention - fix is a per-consumer cursor table (one row
 * per consumer holding the last-dispatched position; query becomes
 * `WHERE created_at > cursor` and scan cost becomes O(backlog)
 * instead of O(total events)).
 */
export async function listUnconsumedDomainEvents(db: Db, consumerName: string, batchSize: number) {
  return db
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
    .where(or(isNull(domainEventConsumers.eventId), isNull(domainEventConsumers.lastConsumedAt)))
    .orderBy(domainEvents.createdAt, domainEvents.id)
    .limit(batchSize);
}

/**
 * Record that `consumerName` successfully processed `eventId`.
 * Upsert: no row exists until the first processing attempt lands.
 * Clears `lastError` and bumps `attempts` on both the insert and update
 * paths so a success after prior failures ends with a correct attempt count.
 *
 * No `where` guard on the UPDATE: success is terminal, so a retry that
 * succeeds after a prior failure always stamps `lastConsumedAt` and
 * clears `lastError`. Asymmetric with {@link markDomainEventFailed}'s
 * guarded update - "success wins" is the at-least-once contract.
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
 * Record that `consumerName` failed to process `eventId`. Upsert with
 * same conflict key as {@link markDomainEventConsumed}. Stamps the
 * truncated `error`, bumps `attempts`, and leaves `lastConsumedAt`
 * NULL so {@link listUnconsumedDomainEvents} re-offers the event.
 *
 * Guarded against resurrection: if the row is already consumed
 * (`lastConsumedAt IS NOT NULL`) the UPDATE is skipped and the
 * function returns `undefined`. A late/stale failure report must not
 * un-consume a successfully-processed event - callers treat
 * `undefined` as "someone else got there first."
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
