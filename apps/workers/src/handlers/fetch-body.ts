import type { FetchMessageBodyResult, ImapConnectionCache } from "@kirimail/mail";
import type { Meilisearch } from "@kirimail/search";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Job, PgBoss } from "pg-boss";

import { db, getEmailAccountById, getMessageWithOwnership } from "@kirimail/db";
import * as schema from "@kirimail/db/schema";
import { asNonRetriableImapError, fetchMessageBody, ImapNonRetriableError } from "@kirimail/mail";
import {
  getMessageDoc,
  htmlToPlainText,
  MESSAGES_INDEX_UID,
  searchClient,
  upsertMessageBody,
} from "@kirimail/search";

import { imapCache } from "../caches";
import { resolveImapCredentials } from "../credentials";

type Db = NodePgDatabase<typeof schema>;

export const FETCH_BODY_QUEUE = "fetch-body";

// ---------------------------------------------------------------------------
// Queue Registration
// ---------------------------------------------------------------------------

/** Job payload for the fetch-body. DB row is the source of truth; nothing else is carried. */
export interface FetchBodyJobData {
  messageId: string;
}

/** Registration options for {@link registerFetchBody}. */
export interface RegisterFetchBodyOptions {
  /** Meilisearch index uid the body upsert targets. Defaults to {@link MESSAGES_INDEX_UID}. */
  indexUid?: string;
}

/** Register the fetch-body queue and handler. */
export async function registerFetchBody(
  boss: PgBoss,
  opts: RegisterFetchBodyOptions = {},
): Promise<void> {
  await boss.createQueue(FETCH_BODY_QUEUE, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // Body fetch + per-part download for a message with several text parts can run
    // minutes on slow connections. 5 minutes should covers the worst realistic case.
    expireInSeconds: 300,
  });

  await boss.work(
    FETCH_BODY_QUEUE,
    // localConcurrency let us run body-fetches for multiple accounts in parallel.
    // 3 is conservative starting point as IMAP servers may throttle aggressive parallel reads.
    { batchSize: 1, localConcurrency: 3 },
    async (jobs: Job<FetchBodyJobData>[]): Promise<void> => {
      const job = jobs[0]!;
      try {
        await handleFetchBody({
          db,
          meili: searchClient,
          imapCache,
          messageId: job.data.messageId,
          indexUid: opts.indexUid ?? MESSAGES_INDEX_UID,
        });
      } catch (err) {
        // Deterministic IMAP failures (rotated credentials, mailbox renamed or
        // deleted server-side, BAD on FETCH) won't change on retry - mark the
        // job complete so pg-boss doesn't burn 3x retry slots on a poisoned job.
        //
        // NOTE: This is NOT pg-boss dead-lettering - returning here marks the job successful,
        // so it leaves no DLQ entry and no failure metric. If a real DLQ is wired up later,
        // throw a typed error pg-boss can route there instead.
        //
        // NOTE: The discard is permanent for this message's body fields until a
        // body-only reindex composer ships. Revisit when telemetry lands (emit
        // `fetch_body_discarded_total`).
        if (err instanceof ImapNonRetriableError) {
          console.error(
            `[${FETCH_BODY_QUEUE}] message ${job.data.messageId} discarded (deterministic IMAP failure, non-retriable):`,
            err,
          );
          return;
        }
        console.error(`[${FETCH_BODY_QUEUE}] message ${job.data.messageId} failed:`, err);
        throw err;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Command Execution
// ---------------------------------------------------------------------------

/** Per-text-part byte ceiling. Paired with {@link MAX_BYTES_TEXT_TOTAL}. */
const MAX_BYTES_TEXT_PART = 2 * 1024 * 1024;
/**
 * Per-message aggregate ceiling across all text parts.
 *
 * 4 MiB is enough for two full-size parts (text/plain + text/html, the common
 * multipart/alternative shape) or many small parts in a digest. Once exhausted,
 * the primitive stops downloading further text leaves and returns what it has.
 */
const MAX_BYTES_TEXT_TOTAL = 4 * 1024 * 1024;

/** Runtime dependencies for {@link handleFetchBody}. */
export interface FetchBodyDeps {
  db: Db;
  meili: Meilisearch;
  imapCache: ImapConnectionCache;
  messageId: string;
  indexUid: string;
}

/**
 * Body-fetch worker for one message: pulls text MIME parts via {@link fetchMessageBody}
 * and partial-merges `{bodyText, bodyHtml, bodyTextDerived}` onto the existing Meilisearch doc.
 *
 * Idempotent under at-least-once delivery: re-running for the same message id is
 * harmless and free, because the pre-IMAP guard below short-circuits once body
 * fields are populated - duplicate dispatch doesn't re-pull bytes off IMAP.
 *
 * Several early-returns are benign races or work-already-done, not failures.
 */
export async function handleFetchBody(deps: FetchBodyDeps): Promise<void> {
  const { db, meili, imapCache, messageId, indexUid } = deps;

  const row = await getMessageWithOwnership(db, messageId);
  if (!row) {
    // Benign race with delete (sync removed the row, or `mailbox.deleted`
    // cascade fired). The corresponding `message.deleted` event will clean
    // up the Meilisearch doc on the dispatcher side.
    console.log(`[${FETCH_BODY_QUEUE}] message ${messageId} not found, skipping`);
    return;
  }
  if (row.message.encrypted) {
    // End-to-end encrypted (PGP/MIME or S/MIME) - we'd be indexing ciphertext
    // or the unparseable cleartext envelope wrapper. The `encrypted: true` flag
    // on the existing Meilisearch doc is the UI's signal to render a placeholder;
    // absent body fields is the correct state.
    console.log(`[${FETCH_BODY_QUEUE}] message ${messageId} is encrypted, skipping`);
    return;
  }

  // Pre-IMAP guard: a Meilisearch round-trip avoids pulling MB of body bytes off
  // IMAP when the doc is already gone (deletion landed before we started) or
  // already body-indexed (duplicate dispatch). The late guard further down
  // catches the residual race where deletion lands DURING the IMAP fetch.
  const preExisting = await getMessageDoc(meili, messageId, indexUid);
  if (preExisting === null) {
    console.log(
      `[${FETCH_BODY_QUEUE}] meilisearch doc for message ${messageId} not found, skipping`,
    );
    return;
  }
  // NOTE: this guard answers "has body-fetch run?", not "is anything in body fields?".
  // `bodyTextDerived` is intentionally NOT in this OR: it's only ever written alongside
  // `bodyHtml` (derivation requires `bodyHtml` as input), so the `bodyHtml` arm covers
  // it transitively. If a future change decouples `bodyTextDerived` from `bodyHtml`,
  // or adds a new body field (e.g. `bodyMarkdown`) that fetch-body should also fill,
  // this branch must be updated - otherwise duplicate runs will silently skip messages
  // that were meant to be filled.
  if (preExisting.bodyText !== undefined || preExisting.bodyHtml !== undefined) {
    console.log(
      `[${FETCH_BODY_QUEUE}] message ${messageId} body fields already populated, skipping`,
    );
    return;
  }

  const account = await getEmailAccountById(db, row.emailAccountId);
  if (!account) {
    // Race: another transaction may have deleted the email account between the
    // message-row read above and this lookup. The cascade also wipes our message row,
    // but `row` is already an in-memory snapshot pointing at a now-gone account id.
    console.warn(
      `[${FETCH_BODY_QUEUE}] account ${row.emailAccountId} not found for message ${messageId}, skipping`,
    );
    return;
  }

  const creds = resolveImapCredentials(account);
  let result: FetchMessageBodyResult;
  try {
    result = await imapCache.execute(row.emailAccountId, creds, (client) =>
      fetchMessageBody(client, {
        mailbox: row.mailboxPath,
        uid: row.message.providerUid,
        maxBytesPerPart: MAX_BYTES_TEXT_PART,
        maxBytesTotal: MAX_BYTES_TEXT_TOTAL,
      }),
    );
  } catch (err) {
    // Wrap spans both connect-phase (auth from getOrConnect, before fetchMessageBody runs)
    // and command-phase (NO/BAD from inside the primitive) so both deterministic shapes
    // route to the typed non-retriable. Non-deterministic errors fall through via `?? err`
    // and bubble for retry.
    throw (
      asNonRetriableImapError(
        err,
        `IMAP body fetch failed deterministically (mailbox: ${JSON.stringify(row.mailboxPath)}, uid: ${row.message.providerUid})`,
      ) ?? err
    );
  }
  if (result.uidNotFound) {
    // UID is no longer on the server (message moved/expunged between sync and now). The next
    // sync's reconciliation will emit `message.deleted` and the Meilisearch doc cleanup follows.
    console.warn(
      `[${FETCH_BODY_QUEUE}] message ${messageId} (uid ${row.message.providerUid}) not found on server, skipping`,
    );
    return;
  }

  const { bodyText, bodyHtml } = result;
  // HTML-only mail would be unsearchable by body content - `bodyHtml` is not
  // in `searchableAttributes`. Derive a plain-text projection only when there
  // was no real text/plain part; otherwise leave `bodyTextDerived` undefined.
  //
  // NOTE: A few senders ship a stub `text/plain` ("View this email in your
  // browser. Click here: <url>") with the real content only in `text/html` -
  // typically hand-rolled mailers or legacy templates that don't auto-generate
  // plain text. Under this guard derivation skips, so HTML-only tokens miss
  // search. Fix is dropping the `bodyText === undefined` guard; deferred until
  // search-miss reports surface this shape.
  const bodyTextDerived =
    bodyText === undefined && bodyHtml !== undefined ? htmlToPlainText(bodyHtml) : undefined;
  if (bodyText === undefined && bodyHtml === undefined) {
    // BODYSTRUCTURE had no text/plain or text/html leaves - exotic MIME
    // shapes, or every text leaf was `Content-Disposition: attachment`
    // (handled by parseAttachments, not body indexing).
    console.log(`[${FETCH_BODY_QUEUE}] message ${messageId} has no indexable body parts, skipping`);
    return;
  }

  // Late orphan guard: a delete that landed during our IMAP fetch (between
  // the pre-IMAP guard and now) would let upsertMessageBody resurrect the
  // doc with body fields but no tenant fields - invisible to scoped
  // queries, unreachable by deleteMessagesBy* primitives. Re-checking
  // shrinks the race to the gap between this read and the upsert below.
  // See NOTE in the @kirimail/search/primitives.ts.
  const existing = await getMessageDoc(meili, messageId, indexUid);
  if (existing === null) {
    console.log(
      `[${FETCH_BODY_QUEUE}] meilisearch doc for message ${messageId} no longer exists, skipping`,
    );
    return;
  }

  await upsertMessageBody(meili, messageId, { bodyText, bodyHtml, bodyTextDerived }, indexUid);
}
