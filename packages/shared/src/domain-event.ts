/**
 * Kind of aggregate a {@link DomainEventType} is about, paired with the
 * aggregate's row id (e.g. `"message"` + `messages.id`). Single-valued
 * today; declared as a union so consumers exhaustively pattern-match
 * instead of passing `string`.
 */
export type DomainAggregateType = "message";

/**
 * Dotted verb-shaped event name on every `domain_events` row. Consumers
 * branch on this. Single-valued today - see {@link DomainAggregateType}.
 *
 * NOTE: `payload` is `Record<string, unknown>` at the schema layer. When
 * a second event type lands with a non-empty payload, migrate to a
 * discriminated union keyed on `eventType` so payloads type-check
 * per-variant instead of `unknown`.
 */
export type DomainEventType = "message.synced";
