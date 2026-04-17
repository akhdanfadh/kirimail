import type { ImapFlow } from "imapflow";

// ---------------------------------------------------------------------------
// Module conventions
// ---------------------------------------------------------------------------
//
// Lock & connection lifecycle: each primitive acquires a mailbox lock
// internally and releases it in a finally block. Connection lifecycle
// (connect/logout) is the caller's responsibility.
//
// Error model: failures fall into three buckets.
//   1. Soft decline -> returned as `{ ok: false, reason: ... }`. Today only
//      `uid-validity-stale` (caller's UIDs reference a previous mailbox
//      generation; drop the command and let sync reconcile).
//   2. Non-retriable -> `ImapPrimitiveNonRetriableError`. Deterministic; same
//      input will fail the same way. Job queues should dead-letter.
//   3. Retriable -> raw `Error` (network, auth expiry, server NO that
//      imapflow re-raises). Queue retries normally.
//
// imapflow swallowing: store/move/expunge wrap their server interaction in a
// catch that logs as warn and returns falsy, hiding the original error from
// us. We treat falsy as non-retriable because we can't distinguish the cause.
// APPEND is the exception - append.js re-raises, so a falsy return there
// means a true precondition failure, not a swallowed server NO.
// See: https://github.com/postalsys/imapflow/blob/v1.2.18/lib/commands/

/** Soft decline returned when `expectedUidValidity` no longer matches. */
export type StaleUidValidity = { ok: false; reason: "uid-validity-stale" };

/** Deterministic failure - safe to dead-letter without retry. */
export class ImapPrimitiveNonRetriableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapPrimitiveNonRetriableError";
  }
}

/**
 * True when the current mailbox's UIDVALIDITY matches `expected` (or no
 * expectation was set). Caller must hold the mailbox lock.
 *
 * Throws if `client.mailbox` is unset after a successful lock - that means
 * the lock contract was violated (lock implies SELECTED state, which
 * populates `client.mailbox`). Fail-closed: a missing mailbox state must
 * not silently bypass the UIDVALIDITY guard.
 */
function uidValidityMatches(client: ImapFlow, expected: number | undefined): boolean {
  if (expected === undefined) return true;
  if (!client.mailbox) {
    throw new ImapPrimitiveNonRetriableError(
      "IMAP precondition violated: mailbox lock held but client.mailbox is unset",
    );
  }
  return Number(client.mailbox.uidValidity) === expected;
}

// ---------------------------------------------------------------------------
// FLAGS operation
// ---------------------------------------------------------------------------

/** How to mutate flags: add, remove, or replace the entire flag set. */
export type FlagOperation = "add" | "remove" | "set";

export interface StoreFlagsInput {
  mailbox: string;
  uids: string | number[];
  flags: string[];
  operation: FlagOperation;
  /** If set, reject when the mailbox's current UIDVALIDITY differs. */
  expectedUidValidity?: number;
}

export type StoreFlagsResult = { ok: true } | StaleUidValidity;

/**
 * Mutate flags on messages in a single mailbox via IMAP STORE.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc3501#section-6.4.6
 */
export async function storeFlags(
  client: ImapFlow,
  input: StoreFlagsInput,
): Promise<StoreFlagsResult> {
  const lock = await client.getMailboxLock(input.mailbox, {
    description: `storeFlags ${input.operation} ${JSON.stringify(input.flags)}`,
  });
  try {
    if (!uidValidityMatches(client, input.expectedUidValidity)) {
      return { ok: false, reason: "uid-validity-stale" };
    }

    const opts = { uid: true } as const;
    let ok: boolean;
    switch (input.operation) {
      case "add":
        ok = await client.messageFlagsAdd(input.uids, input.flags, opts);
        break;
      case "remove":
        ok = await client.messageFlagsRemove(input.uids, input.flags, opts);
        break;
      case "set":
        ok = await client.messageFlagsSet(input.uids, input.flags, opts);
        break;
    }
    if (!ok) {
      // imapflow swallowed the cause (see module header). Likely empty UIDs,
      // all flags filtered by mailbox permanentFlags, or server NO.
      throw new ImapPrimitiveNonRetriableError(
        `IMAP STORE returned no result (mailbox: ${JSON.stringify(input.mailbox)}, ` +
          `operation: ${input.operation}, flags: ${JSON.stringify(input.flags)})`,
      );
    }
    return { ok: true };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// MOVE operation
// ---------------------------------------------------------------------------

export interface MoveMessagesInput {
  mailbox: string;
  destination: string;
  uids: string | number[];
  /** If set, reject when the mailbox's current UIDVALIDITY differs. */
  expectedUidValidity?: number;
}

export type MoveMessagesResult =
  | {
      ok: true;
      /** Source UID -> destination UID. Populated when the server supports UIDPLUS (RFC 4315). */
      uidMap: Map<number, number>;
    }
  | StaleUidValidity;

/**
 * Move messages from one mailbox to another via IMAP MOVE.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6851
 */
export async function moveMessages(
  client: ImapFlow,
  input: MoveMessagesInput,
): Promise<MoveMessagesResult> {
  const lock = await client.getMailboxLock(input.mailbox, {
    description: `moveMessages -> ${JSON.stringify(input.destination)}`,
  });
  try {
    if (!uidValidityMatches(client, input.expectedUidValidity)) {
      return { ok: false, reason: "uid-validity-stale" };
    }

    const result = await client.messageMove(input.uids, input.destination, { uid: true });
    if (!result) {
      // imapflow swallowed the cause (see module header). Likely empty UIDs
      // or non-existent destination.
      throw new ImapPrimitiveNonRetriableError(
        `IMAP MOVE returned no result (${JSON.stringify(input.mailbox)} -> ` +
          `${JSON.stringify(input.destination)})`,
      );
    }
    return { ok: true, uidMap: result.uidMap ?? new Map() };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// DELETE/EXPUNGE operation
// ---------------------------------------------------------------------------

export interface ExpungeMessagesInput {
  mailbox: string;
  uids: string | number[];
  /** If set, reject when the mailbox's current UIDVALIDITY differs. */
  expectedUidValidity?: number;
}

export type ExpungeMessagesResult = { ok: true } | StaleUidValidity;

/**
 * Permanently remove messages via STORE \Deleted + EXPUNGE. The conditional
 * logic (move to Trash first vs. permanent delete) belongs in the caller.
 *
 * Uses UID EXPUNGE when the server supports UIDPLUS so only the specified
 * UIDs are expunged; falls back to plain EXPUNGE otherwise.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc4315#section-2.1
 */
export async function expungeMessages(
  client: ImapFlow,
  input: ExpungeMessagesInput,
): Promise<ExpungeMessagesResult> {
  const lock = await client.getMailboxLock(input.mailbox, {
    description: `expungeMessages ${
      Array.isArray(input.uids) ? `${input.uids.length} uid(s)` : input.uids
    }`,
  });
  try {
    if (!uidValidityMatches(client, input.expectedUidValidity)) {
      return { ok: false, reason: "uid-validity-stale" };
    }

    const ok = await client.messageDelete(input.uids, { uid: true });
    if (!ok) {
      // imapflow swallowed the cause (see module header). Likely empty UIDs
      // or read-only mailbox.
      throw new ImapPrimitiveNonRetriableError(
        `IMAP EXPUNGE returned no result (mailbox: ${JSON.stringify(input.mailbox)})`,
      );
    }
    return { ok: true };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// APPEND operation
// ---------------------------------------------------------------------------

export interface AppendMessageInput {
  /** Target mailbox path (e.g., "Sent", "Drafts"). */
  mailbox: string;
  /** Complete RFC 5322 message bytes. */
  raw: Buffer;
  /** Flags to set on the appended message (e.g., ["\\Seen"], ["\\Draft"]). */
  flags?: string[];
  /** IMAP internal date. Defaults to server time when omitted. */
  internalDate?: Date;
}

/**
 * UIDPLUS (RFC 4315) APPENDUID returns uid and uidvalidity atomically - both
 * present (modern servers) or both absent (legacy). Pairing them in the type
 * lets callers null-check once. `ok: true` is kept for shape parity with the
 * other primitives.
 */
export type AppendMessageResult = {
  ok: true;
} & ({ uid: number; uidValidity: number } | { uid: null; uidValidity: null });

/**
 * Append a raw RFC 5322 message to a mailbox via IMAP APPEND.
 *
 * APPEND addresses the destination by path, not the selected mailbox, so it
 * doesn't contend with `getMailboxLock` callers operating on other mailboxes.
 *
 * Unlike the other primitives in this module, append.js re-raises server
 * errors instead of swallowing them, so server NOs (TRYCREATE, OVERQUOTA)
 * and network errors throw raw with `serverResponseCode` intact for retry
 * classification.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc3501#section-6.3.11
 * @see https://datatracker.ietf.org/doc/html/rfc4315#section-3
 */
export async function appendMessage(
  client: ImapFlow,
  input: AppendMessageInput,
): Promise<AppendMessageResult> {
  const res = await client.append(input.mailbox, input.raw, input.flags, input.internalDate);
  if (!res) {
    // append.js short-circuits to falsy when state is not AUTHENTICATED or
    // SELECTED. If the connection is still usable, the cause is a real
    // precondition (programming error). If not, the socket dropped between
    // handover and APPEND - transient, let the queue retry.
    if (!client.usable) {
      throw new Error(
        `IMAP APPEND failed: connection no longer usable ` +
          `(mailbox: ${JSON.stringify(input.mailbox)})`,
      );
    }
    throw new ImapPrimitiveNonRetriableError(
      `IMAP APPEND returned no result on a usable connection ` +
        `(mailbox: ${JSON.stringify(input.mailbox)})`,
    );
  }
  // imapflow returns uidValidity as BigInt; coerce to Number to match the
  // codebase's `{ mode: "number" }` columns. UIDVALIDITY is 32-bit unsigned,
  // safely within Number.MAX_SAFE_INTEGER.
  if (typeof res.uid === "number" && res.uidValidity !== undefined && res.uidValidity !== null) {
    return { ok: true, uid: res.uid, uidValidity: Number(res.uidValidity) };
  }
  return { ok: true, uid: null, uidValidity: null };
}
