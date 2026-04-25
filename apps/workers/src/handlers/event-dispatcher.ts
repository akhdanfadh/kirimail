import type { Meilisearch, SyncedMessageDoc } from "@kirimail/search";
import type { DomainEventType, MessageAddress } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Job, PgBoss } from "pg-boss";

import {
  db,
  getMessageWithOwnership,
  listUnconsumedDomainEvents,
  markDomainEventConsumed,
  markDomainEventFailed,
} from "@kirimail/db";
import * as schema from "@kirimail/db/schema";
import {
  MeilisearchApiError,
  MeilisearchError,
  MeilisearchRequestError,
  MeilisearchRequestTimeOutError,
  MeilisearchTaskTimeOutError,
  MESSAGES_INDEX_UID,
  upsertSyncedMessage,
  searchClient,
} from "@kirimail/search";

type Db = NodePgDatabase<typeof schema>;

export const EVENT_DISPATCHER_QUEUE = "event-dispatcher";

// ---------------------------------------------------------------------------
// Queue registration
// ---------------------------------------------------------------------------

// TODO: We don't warn automatically when the same event keeps failing.
// Finding these "poison" events today is a manual query:
//
//   SELECT * FROM domain_event_consumers
//   WHERE last_error IS NOT NULL ORDER BY attempts DESC;
//
// Why we can't just auto-warn on `attempts` crossing a threshold:
// that counter counts EVERY attempt, successes included. A flaky event can hit the
// threshold value during a success and skip past it, e.g. fails 9 times (attempts=9),
// succeeds once (attempts=10), fails again (attempts=11). A "warn when attempts=10
// AND last failed" rule never catches the moment because attempts=10 was a success.
//
// There's also a starvation hazard. The SQL fetch returns oldest events first,
// BATCH_SIZE at a time. If 100+ poison events sit at the head of the queue, every
// tick is 100% poison and `consumed=0`, so the backlog self-enqueue stops firing.
// The 5-min cron just re-fetches the same poison head. Healthy events behind them
// never get processed - search stays stale for those too, not just for the broken ones.
//
// Both fixed by one change: add a `consecutive_failures` column to `domain_event_consumers`,
// reset to 0 on success and incremented on failure. That gives a counter we can threshold
// cleanly (no skipping past values during success), and the SQL fetch can also filter on
// `WHERE consecutive_failures < N` so poison stops blocking the queue head.

const CRON_SCHEDULE = "*/5 * * * *";
const BATCH_SIZE = 100;

/** Registration options for {@link registerEventDispatcher} */
export interface RegisterEventDispatcherOptions {
  /** Meilisearch index uid writes target. Default to {@link MESSAGES_INDEX_UID}. */
  indexUid?: string;
  /** Maximum events one tick processes. Used for resource knob. Default to {@link BATCH_SIZE}. */
  batchSize?: number;
}

/** Register the event-dispatcher queue, handler, and cron safety net. */
export async function registerEventDispatcher(
  boss: PgBoss,
  opts: RegisterEventDispatcherOptions = {},
): Promise<void> {
  const indexUid = opts.indexUid ?? MESSAGES_INDEX_UID;
  const batchSize = opts.batchSize ?? BATCH_SIZE;

  await boss.createQueue(EVENT_DISPATCHER_QUEUE, {
    policy: "stately",
    // The next natural trigger (cron, post-sync, or backlog self-enqueue)
    // is the retry. pg-boss's own retry would just delay it under stately,
    // and keeping pg-boss state minimal makes the ledger (domain_event_consumers)
    // the single source of truth for what's left.
    retryLimit: 0,
    expireInSeconds: 300,
  });

  await boss.work(EVENT_DISPATCHER_QUEUE, { batchSize: 1 }, async (jobs: Job[]): Promise<void> => {
    const job = jobs[0]!;
    const result = await handleEventDispatcher({
      db,
      meili: searchClient,
      indexUid,
      batchSize,
    });
    if (result.consumed > 0 || result.failed > 0 || result.skipped > 0) {
      console.log(
        `[${EVENT_DISPATCHER_QUEUE}] tick ${job.id} consumed ${result.consumed}, ` +
          `failed ${result.failed}, skipped ${result.skipped}`,
      );
    }

    // Self-enqueue if we processed a full batch AND at least one event succeeded.
    // Drains backlogs at worker speed instead of waiting for the next trigger
    // (post-sync push or 5-min cron) which is useful for fresh account's initial sync.
    if (result.consumed > 0 && result.consumed + result.failed + result.skipped === batchSize) {
      try {
        // boss.send returns null (no throw) when stately's dedup kicks in - a tick is
        // already queued from another trigger and will drain the rest. Harmless.
        // This catch is only for real failures (DB down, pg-boss internal error).
        await boss.send(EVENT_DISPATCHER_QUEUE, {});
      } catch (err) {
        console.error(`[${EVENT_DISPATCHER_QUEUE}] backlog-drain self-enqueue failed:`, err);
      }
    }
  });

  // Catches cases where the dispatcher's last tick didn't finish the work
  // (Meilisearch down, mid-tick crash) and no new sync arrives to re-trigger it.
  await boss.schedule(EVENT_DISPATCHER_QUEUE, CRON_SCHEDULE);
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Name used to track this consumer's progress in `domain_event_consumers`.
 * Don't rename once deployed - a new name = a fresh consumer that
 * re-processes every event from scratch.
 */
export const MEILISEARCH_CONSUMER_NAME = "meilisearch-indexer";
/**
 * Event types this handler cares about. Two places read this list:
 * the SQL filter (only these types get pulled into the batch) and
 * the switch below (the `never` default forces a `case` for every
 * listed type). Other event types added to DomainEventType but not
 * here are silently filtered out at SQL - each consumer opts in.
 */
const HANDLED_EVENT_TYPES = ["message.synced"] as const satisfies readonly DomainEventType[];
type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/** Runtime dependencies for {@link handleEventDispatcher}. */
export interface EventDispatcherDeps {
  db: Db;
  meili: Meilisearch;
  indexUid: string;
  batchSize: number;
}

/** Outcome counters for one {@link handleEventDispatcher} tick. */
export interface EventDispatcherResult {
  /** Events processed successfully and marked consumed. */
  consumed: number;
  /** Events that hit a per-event error and were marked failed. */
  failed: number;
  /** Events where `markDomainEventFailed` no-op'ed because the row was already consumed. */
  skipped: number;
}

/**
 * Process one batch of unconsumed domain events for the Meilisearch consumer.
 * Returns {@link EventDispatcherResult} so the pg-boss wrapper can decide
 * whether to self-enqueue for backlog-drain based on actual consume progress.
 */
export async function handleEventDispatcher(
  deps: EventDispatcherDeps,
): Promise<EventDispatcherResult> {
  const events = await listUnconsumedDomainEvents(
    deps.db,
    MEILISEARCH_CONSUMER_NAME,
    HANDLED_EVENT_TYPES,
    deps.batchSize,
  );

  let consumed = 0;
  let failed = 0;
  let skipped = 0;

  for (const event of events) {
    try {
      const eventType = event.eventType as HandledEventType;
      switch (eventType) {
        case "message.synced":
          await handleMessageSynced(deps, event.aggregateId);
          break;
        default: {
          const _exhaustive: never = eventType;
          throw new Error(
            `[${EVENT_DISPATCHER_QUEUE}] unhandled eventType: ${String(_exhaustive)}`,
          );
        }
      }
    } catch (err) {
      if (
        err instanceof MeilisearchRequestError ||
        err instanceof MeilisearchRequestTimeOutError ||
        err instanceof MeilisearchTaskTimeOutError
      ) {
        // Distinguish Meilisearch infra error (connection, timeout, task supervision)
        // from per-event errors. Infra errors abort the tick so the next trigger retries
        // cleanly; per-event errors stamp `last_error` and the batch continues.
        console.error(
          `[${EVENT_DISPATCHER_QUEUE}] infra error on event ${event.id}, aborting tick:`,
          err,
        );
        throw err;
      }

      if (err instanceof MeilisearchError && !(err instanceof MeilisearchApiError)) {
        // Flag unknown Meilisearch error before falling through to per-event treatment.
        // If a future SDK version adds a new retryable error class we haven't whitelisted
        // above, we'd otherwise silently stamp `last_error` on transient outages.
        console.warn(
          `[${EVENT_DISPATCHER_QUEUE}] unknown Meilisearch error class ${err.constructor.name} on event; ` +
            `treating as per-event (might be a new retryable type - check the SDK):`,
          err,
        );
      }

      const message = err instanceof Error ? err.message : String(err);
      const failedRow = await markDomainEventFailed(
        deps.db,
        event.id,
        MEILISEARCH_CONSUMER_NAME,
        message,
      );
      if (failedRow === undefined) {
        // markFailed no-op: the consumer row was already consumed by another tick.
        // Doesn't normally happen as stately + SKIP LOCKED gives single-tick exclusivity
        // across pg-boss instances. Realistic trigger: a tick exceeded expireInSeconds,
        // pg-boss reaped its job slot and a new tick claimed the next pg-boss job, but
        // the old handler kept running in JS land (no thread-interrupt) and now races the
        // new one. Also covers operator manual DB mutations. No persistent error landed,
        // so count as `skipped` (not `failed`).
        console.warn(
          `[${EVENT_DISPATCHER_QUEUE}] event ${event.id} threw (${message}) but row was already consumed; ` +
            `treating as success (counted as skipped)`,
        );
        skipped++;
      } else {
        failed++;
        console.error(`[${EVENT_DISPATCHER_QUEUE}] event ${event.id} failed: ${message}`);
      }
      continue;
    }

    await markDomainEventConsumed(deps.db, event.id, MEILISEARCH_CONSUMER_NAME);
    consumed++;
  }

  return { consumed, failed, skipped };
}

/**
 * Compose + write the sync-stage doc (headers + attachment metadata) for a
 * synced message. Row-not-found is an idempotent no-op (message deleted
 * between emission and dispatch).
 */
// NOTE: One Meilisearch call per event = ~200 HTTP round-trips per 100-event batch.
// Negligible on localhost, ~10-20s/tick against remote Meilisearch (50-100ms ping).
// Fix: bulk updateDocuments (~3-5 round-trips). Build when ticks exceed 10s,
// or remote deployments become common.
async function handleMessageSynced(deps: EventDispatcherDeps, messageId: string): Promise<void> {
  const { db, meili, indexUid } = deps;
  const row = await getMessageWithOwnership(db, messageId);
  if (!row) {
    // TODO: this branch hits when an event references a message already deleted from
    // Postgres. Some delete paths don't emit events today, so search may keep returning
    // a stale doc for this message until a `message.deleted` producer + consumer is added.
    // We don't band-aid with a defensive doc-delete here, because the dominant gap is on
    // the producer side - those deletes never even reach this consumer.
    //
    // Important: when added, producer and consumer must ship together. A producer-only
    // change would emit events that HANDLED_EVENT_TYPES filters out at SQL,
    // piling up unconsumed in the ledger.
    //
    // `warn` level so a real bug (a truly missing row) still surfaces.
    console.warn(
      `[${EVENT_DISPATCHER_QUEUE}] message ${messageId} not found; marking event consumed`,
    );
    return;
  }

  const syncedMessage: SyncedMessageDoc = {
    id: row.message.id,
    userId: row.userId,
    emailAccountId: row.emailAccountId,
    mailboxId: row.message.mailboxId,
    subject: row.message.subject,
    from: row.message.fromAddress.map(formatMessageAddress).filter(isNotNull),
    to: row.message.toAddress.map(formatMessageAddress).filter(isNotNull),
    cc: row.message.ccAddress.map(formatMessageAddress).filter(isNotNull),
    bcc: row.message.bccAddress.map(formatMessageAddress).filter(isNotNull),
    receivedDate: Math.floor(row.message.internalDate.getTime() / 1000),
    // NOTE: Octets and bytes are synonymous for RFC 5322 / RFC 9051.
    // Current schema sticks with the IMAP wire term (octets); slightly
    // inconsistent so schema might be renamed for better semantics.
    sizeBytes: row.message.sizeOctets,
    flags: row.message.flags,
    attachments: row.message.attachments,
  };
  await upsertSyncedMessage(meili, syncedMessage, indexUid);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a parsed IMAP ENVELOPE address to the form the search doc stores:
 * `"Name <addr>"` when a display name is present, `"<addr>"` when it is NIL.
 * Returns `null` for RFC 5322 group-syntax sentinels (`address: null`) so
 * callers can filter them out cleanly.
 */
function formatMessageAddress(a: MessageAddress): string | null {
  if (a.address === null) return null;
  return a.name ? `${a.name} <${a.address}>` : `<${a.address}>`;
}

function isNotNull<T>(v: T | null): v is T {
  return v !== null;
}
