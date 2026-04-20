import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Domain events - facts about things that happened in the application
 * (a message was synced, a tag was applied) - recorded alongside the
 * domain change itself in one transaction so asynchronous consumers
 * can process them reliably without loss on crash. Known in
 * distributed-systems literature as the transactional outbox pattern.
 *
 * Insert-only: rows represent immutable historical facts. No `updatedAt`
 * by design - an event never changes after it is recorded.
 *
 * NOTE: rows accumulate without bound until retention lands. Revisit
 * when `domain_events` crosses ~1M rows or the dispatcher's
 * `listUnconsumedDomainEvents` tick exceeds ~50ms in production - fix
 * is a retention cron, or the reindex primitive's truncate-and-reemit
 * flow once that arrives.
 */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: text("id").primaryKey(),
    /**
     * The kind of thing this event is about, e.g. `"message"` or `"mailbox"`.
     * Paired with `aggregateId` to identify the specific domain object.
     */
    aggregateType: text("aggregate_type").notNull(),
    /**
     * ID of the specific `aggregateType` instance
     * (e.g., `messages.id` when `aggregateType = "message"`).
     */
    aggregateId: text("aggregate_id").notNull(),
    /**
     * What happened, as a dotted verb-shaped string:
     * `"message.synced"`, `"tag.applied"`. Consumers branch on this.
     */
    eventType: text("event_type").notNull(),
    /** Optional event-type-specific extra data; kept small by convention. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** When the event was recorded. Consumers process in this order. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("domain_events_created_at_idx").on(table.createdAt)],
);

/**
 * Per-consumer progress tracking for {@link domainEvents}. One row per
 * `(event, consumer)` pair, created lazily the first time a consumer
 * tries to process an event - absence of a row means the consumer has
 * never seen the event. Consumers are identified by a stable name, so
 * adding one takes no schema change.
 *
 * `last*` fields hold current state, not history - a later retry overwrites
 * a prior error, a later success overwrites a prior success timestamp.
 */
export const domainEventConsumers = pgTable(
  "domain_event_consumers",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => domainEvents.id, { onDelete: "cascade" }),
    /**
     * Stable identifier for the consumer, e.g., `"meilisearch-indexer"`.
     * Immutable once deployed: renaming creates a new consumer that has never seen any events.
     */
    consumerName: text("consumer_name").notNull(),
    /**
     * Timestamp of the most recent successful processing;
     * `NULL` before the first success or when the most recent attempt failed.
     */
    lastConsumedAt: timestamp("last_consumed_at", { withTimezone: true }),
    /**
     * Error text from the most recent failed attempt;
     * `NULL` before the first attempt or after any success.
     */
    lastError: text("last_error"),
    /**
     * Accepted transitions into this row - successful consumes plus
     * failed-when-not-already-consumed attempts. Always `>= 1` on
     * existing rows; the `.default(0)` is a safety net for direct-SQL
     * inserts that forget to set it.
     */
    attempts: integer("attempts").notNull().default(0),
    /** When the consumer first attempted this event. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** Refreshed on every write - effectively the timestamp of the last attempt. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.consumerName] })],
);
