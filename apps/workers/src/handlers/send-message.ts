import type { SmtpCredentials, SmtpSendResult } from "@kirimail/mail";
import type { JobWithMetadata, PgBoss } from "pg-boss";

import {
  db,
  deleteOutboundMessage,
  getOutboundMessageById,
  getSmtpIdentityById,
  markOutboundMessageFailed,
  markPendingOutboundMessageSending,
  markSendingOutboundMessageSent,
  resetSendingOutboundMessageToPending,
} from "@kirimail/db";
import { classifySmtpError } from "@kirimail/mail";

import { smtpCache } from "../caches";
import { resolveSmtpCredentials } from "../credentials";

/**
 * Job payload for send-message. DB row is the source of truth; nothing else
 * is carried. Producers write the `outbound_messages` row first and then
 * enqueue this job with the row ID.
 */
export interface SendMessageJobData {
  outboundMessageId: string;
}

/**
 * Retry context for the current invocation, mirroring fields from
 * pg-boss's {@link JobWithMetadata}. `retryCount` is the number of prior
 * failures (0 on first attempt, 1 on first retry, ...); `retryLimit` is
 * the queue's cap. `retryCount >= retryLimit` marks the final allowed
 * attempt - a further transient failure cannot be retried by pg-boss.
 */
export interface SendMessageAttempt {
  retryCount: number;
  retryLimit: number;
}

/** Register the send-message queue and handler. */
export async function registerSendMessage(boss: PgBoss): Promise<void> {
  await boss.createQueue("send-message", {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // 10min accommodates the SMTP inactivity timeout (5min) + socket
    // timeout (+30s) plus safety margin for large-payload bursts.
    expireInSeconds: 600,
  });

  // localConcurrency: up to 5 accounts send in parallel; same-account
  // sends serialize through the transport cache (maxConnections: 1).
  // includeMetadata: exposes retryCount/retryLimit for exhaustion detection.
  await boss.work<SendMessageJobData>(
    "send-message",
    { batchSize: 1, localConcurrency: 5, includeMetadata: true },
    async (jobs: JobWithMetadata<SendMessageJobData>[]): Promise<void> => {
      const job = jobs[0]!;
      await handleSendMessage(boss, job.data, {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
    },
  );
}

/**
 * Drive a `pending` outbound_messages row through SMTP transmission. The
 * canonical state-machine diagram lives in
 * `packages/db/src/repositories/outbound-messages.ts`; this handler walks
 * it top-down with the WHY for each branch at the corresponding inline site.
 */
export async function handleSendMessage(
  boss: PgBoss,
  data: SendMessageJobData,
  attempt: SendMessageAttempt,
): Promise<void> {
  const { outboundMessageId } = data;

  const row = await getOutboundMessageById(db, outboundMessageId);
  if (!row) {
    // Race with reaper/manual SQL - benign. Job completes without throwing.
    console.warn(`[send-message] row ${outboundMessageId} not found, skipping`);
    return;
  }

  if (row.status !== "pending") {
    // Another worker claimed it, or a reaper terminalized it. The guarded
    // transitions below would no-op anyway; returning early saves the
    // round-trip and keeps the log clearer.
    console.warn(
      `[send-message] row ${outboundMessageId} in status "${row.status}" (expected "pending"), skipping`,
    );
    return;
  }

  // -- Pre-dispatch: identity + credentials ----------------------------------
  //
  // Concurrent-race invariant: pre-dispatch is a pure function of
  // (stored row, module-level encryption key). Two workers racing past
  // the early-return above both read the same identity (FK RESTRICT
  // blocks mid-flight delete) and decrypt with the same key, producing
  // identical outcomes - markFailed's `pending -> failed` guard makes
  // the second call a no-op.
  //
  // Weakens if pre-dispatch ever consults mutable external state
  // (rotating key cache, live identity metadata). Then the markFailed
  // branches below must tighten from `pending|sending -> failed` to
  // `pending -> failed` only, or a racing pre-dispatch failure could
  // retroactively terminalize another worker's in-flight SMTP.
  const identity = await getSmtpIdentityById(db, row.smtpIdentityId);
  if (!identity) {
    // FK RESTRICT prevents smtp_identities deletion while outbound rows
    // reference them; this branch is defense-in-depth against schema drift.
    await markOutboundMessageFailed(
      db,
      row.id,
      "precondition",
      `SMTP identity ${row.smtpIdentityId} not found`,
    );
    console.error(
      `[send-message] row ${row.id} references missing identity ${row.smtpIdentityId}, marked failed`,
    );
    return;
  }

  if (identity.emailAccountId !== row.emailAccountId) {
    // Composite FK `(email_account_id, smtp_identity_id)` also makes this
    // unreachable. A tripped guard here means schema or FK broke.
    await markOutboundMessageFailed(
      db,
      row.id,
      "precondition",
      `SMTP identity ${identity.id} belongs to account ${identity.emailAccountId}, not ${row.emailAccountId}`,
    );
    console.error(
      `[send-message] row ${row.id} cross-account mismatch (identity account ${identity.emailAccountId} vs row account ${row.emailAccountId}), marked failed`,
    );
    return;
  }

  let smtpCreds: SmtpCredentials;
  try {
    smtpCreds = resolveSmtpCredentials(identity);
  } catch (err) {
    // Wrong CREDENTIAL_ENCRYPTION_KEY or corrupted envelope. Not an SMTP
    // `auth` issue - the server was never contacted. `precondition`
    // distinguishes local-env failures from server-side rejections.
    const message = err instanceof Error ? err.message : String(err);
    await markOutboundMessageFailed(
      db,
      row.id,
      "precondition",
      `Failed to decrypt SMTP credentials: ${message}`,
    );
    console.error(`[send-message] row ${row.id} credential decrypt failed:`, err);
    return;
  }

  // -- Claim row (pending -> sending, bumps attempts) ------------------------
  const claimed = await markPendingOutboundMessageSending(db, row.id);
  if (!claimed) {
    // Row transitioned out of `pending` between the status check and here -
    // a concurrent worker's markSending, or a reaper / manual SQL moved it.
    console.warn(`[send-message] row ${row.id} no longer in pending, skipping`);
    return;
  }

  // -- SMTP send -------------------------------------------------------------
  let result: SmtpSendResult;
  try {
    result = await smtpCache.send(row.emailAccountId, smtpCreds, row.rawMime, {
      from: row.envelopeFrom,
      to: row.envelopeTo,
    });
  } catch (err) {
    const classified = classifySmtpError(err);
    if (classified.category === "transient" || classified.category === "rate-limit") {
      // Final attempt: pg-boss won't retry again. Reset-and-throw would
      // orphan the row in `pending`; markFailed terminalizes with the
      // category preserved (the transition is about lifecycle, not error class).
      if (attempt.retryCount >= attempt.retryLimit) {
        await markOutboundMessageFailed(db, row.id, classified.category, classified.message);
        console.error(
          `[send-message] row ${row.id} ${classified.category} error on final attempt ` +
            `(retryCount=${attempt.retryCount}, retryLimit=${attempt.retryLimit}), marked failed:`,
          classified.message,
        );
        return;
      }
      // Stamp before throwing: throwing first would unwind the stack
      // before the UPDATE runs, losing the retry reason.
      await resetSendingOutboundMessageToPending(
        db,
        row.id,
        classified.category,
        classified.message,
      );
      console.warn(
        `[send-message] row ${row.id} ${classified.category} error, resetting to pending for retry:`,
        classified.message,
      );
      throw err;
    }
    // auth | recipient | protocol: deterministic, do not retry.
    await markOutboundMessageFailed(db, row.id, classified.category, classified.message);
    console.error(
      `[send-message] row ${row.id} ${classified.category} error, marked failed:`,
      classified.message,
    );
    return;
  }

  if (result.accepted.length === 0) {
    // Defensive: a conforming SMTP server can't return 250 to DATA with zero
    // accepted RCPTs (RFC 5321), and nodemailer typically throws EENVELOPE
    // in that case. If it ever resolves here with accepted=[], the delivery
    // didn't happen - surface as a recipient failure rather than marking
    // the row `sent` with no actual transmissions. Covered by the unit test
    // file via a stubbed smtpCache.send.
    const rejectedList = result.rejected.join(", ") || "(empty)";
    await markOutboundMessageFailed(
      db,
      row.id,
      "recipient",
      `All envelope recipients rejected: ${rejectedList}`,
    );
    console.error(
      `[send-message] row ${row.id} SMTP resolved with zero accepted recipients (rejected: ${rejectedList}), marked failed`,
    );
    return;
  }

  if (result.rejected.length > 0) {
    // Partial rejection: server accepted envelope but refused some recipients
    // mid-DATA. The message is on the wire for the accepted set - the row
    // transitions to `sent` with the rejected addresses persisted so
    // consumers can see the partial outcome rather than a plain "sent".
    console.warn(
      `[send-message] row ${row.id} partial recipient rejection ` +
        `(accepted: ${result.accepted.join(", ")}; rejected: ${result.rejected.join(", ")})`,
    );
  }

  // -- Success: mark sent, then hand off to append-sent ----------------------
  const marked = await markSendingOutboundMessageSent(db, row.id, result.rejected);
  if (!marked) {
    // Row mutated between send and markSent (reaper / admin SQL). Message
    // is already on the wire; nothing to roll back and append-sent is skipped.
    console.warn(
      `[send-message] row ${row.id} transitioned out of "sending" before markSent; SMTP already delivered`,
    );
    return;
  }

  if (identity.appendToSent) {
    // singletonKey absorbs duplicate append-sent enqueues for the same
    // messageId across worker restarts / retried send jobs. The dedup probe
    // in appendToSentFolder is the correctness backstop; this saves the
    // IMAP round-trip.
    //
    // NOTE: markSent already committed. A boss.send throw triggers a
    // pg-boss retry, but the next invocation early-returns on
    // `status='sent'` - the enqueue is lost, and the sent-row reaper
    // eventually deletes the row without a Sent-folder copy. We catch-
    // and-log; proper fix is markSent + boss.send in one tx (pg-boss v12
    // per-call connection override), deferred until a repo-wide tx story
    // is designed or append-reliability SLOs make the one-site patch worth it.
    try {
      await boss.send(
        "append-sent",
        { outboundMessageId: row.id },
        { singletonKey: row.messageId },
      );
      console.log(
        `[send-message] row ${row.id} sent, append-sent enqueued (messageId ${row.messageId})`,
      );
    } catch (err) {
      console.error(
        `[send-message] row ${row.id} SENT via SMTP but append-sent enqueue FAILED; ` +
          `Sent-folder copy will be lost when the sent-row reaper deletes the row. ` +
          `messageId=${row.messageId}`,
        err,
      );
    }
  } else {
    // No append-sent step -> this handler is the last consumer; delete per
    // the state-machine's delete-on-success contract. Same asymmetry as
    // the enqueue branch above: markSent has committed, so a throw here
    // would only trigger a no-op pg-boss retry (early-return on `sent`)
    // and leave the row for the 6h reaper. Catch-and-log matches.
    try {
      await deleteOutboundMessage(db, row.id);
      console.log(
        `[send-message] row ${row.id} sent with appendToSent=false, row deleted (messageId ${row.messageId})`,
      );
    } catch (err) {
      console.error(
        `[send-message] row ${row.id} SENT via SMTP but row delete FAILED; ` +
          `sent-row reaper will clean it up. messageId=${row.messageId}`,
        err,
      );
    }
  }
}
