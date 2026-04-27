/**
 * Kind of aggregate a {@link DomainEventType} is about, paired with the
 * aggregate's row id (e.g. `"message"` + `messages.id`). Declared as a union
 * so consumers exhaustively pattern-match instead of passing string.
 */
export type DomainAggregateType = "message" | "mailbox";

/**
 * Dotted verb-shaped event name on every `domain_events` row. Consumers branch on this.
 *
 * Producers emit at different granularities (per-message vs per-mailbox);
 * each producer's JSDoc spells out which events it emits and why:
 * - `message.synced`, `message.deleted` - see `applyMailboxSync`
 * - `mailbox.deleted` - see `reconcileMailboxes`
 *
 * NOTE: `payload` is `Record<string, unknown>` at the schema layer. All variants
 * today carry an empty `{}` payload, so the union is fine as a plain string. When
 * the first event lands with a non-empty payload, migrate to a discriminated union
 * keyed on `eventType` so payloads type-check per-variant instead of `unknown`.
 */
export type DomainEventType = "message.synced" | "message.deleted" | "mailbox.deleted";
