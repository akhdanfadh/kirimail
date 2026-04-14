import type { ImapFlow } from "imapflow";

/** How to mutate flags: add, remove, or replace the entire flag set. */
export type FlagOperation = "add" | "remove" | "set";

/** Input for a single flag mutation on one mailbox. */
export interface StoreFlagsInput {
  /** Full mailbox path (e.g., "INBOX", "Sent"). */
  mailbox: string;
  /** UID range string (e.g., "1:5") or array of UID numbers. */
  uids: string | number[];
  /** Flags to mutate (e.g., ["\\Seen"], ["\\Flagged", "\\Deleted"]). */
  flags: string[];
  /** How to apply: add flags, remove flags, or replace all flags. */
  operation: FlagOperation;
  /** If set, reject when the mailbox's current UIDVALIDITY differs (UIDs are stale after a mailbox rebuild). */
  expectedUidValidity?: number;
}

/** Input for a mailbox-to-mailbox move. */
export interface MoveMessagesInput {
  /** Source mailbox path. */
  mailbox: string;
  /** Destination mailbox path. */
  destination: string;
  /** UIDs to move. */
  uids: string | number[];
  /** If set, reject when the mailbox's current UIDVALIDITY differs (UIDs are stale after a mailbox rebuild). */
  expectedUidValidity?: number;
}

/** Input for permanent message removal (STORE \Deleted + EXPUNGE). */
export interface ExpungeMessagesInput {
  /** Mailbox path containing the messages. */
  mailbox: string;
  /** UIDs to expunge. */
  uids: string | number[];
  /** If set, reject when the mailbox's current UIDVALIDITY differs (UIDs are stale after a mailbox rebuild). */
  expectedUidValidity?: number;
}

/**
 * Mutate flags on messages in a single mailbox via IMAP STORE.
 *
 * Acquires a mailbox lock internally and releases it in a finally block.
 * Connection lifecycle (connect/logout) is the caller's responsibility.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc3501#section-6.4.6 - IMAP STORE command
 * @see https://imapflow.com/docs/api/imapflow-client#messageflagsaddrange-flags-options
 * @see https://imapflow.com/docs/api/imapflow-client#getmailboxlockpath-options
 */
export async function storeFlags(client: ImapFlow, input: StoreFlagsInput): Promise<boolean> {
  const lock = await client.getMailboxLock(input.mailbox);
  try {
    if (
      input.expectedUidValidity !== undefined &&
      client.mailbox &&
      Number(client.mailbox.uidValidity) !== input.expectedUidValidity
    ) {
      return false;
    }

    // Returns true when the STORE command completes. Returns false on
    // server-level rejection, empty flags on add/remove, or flags not
    // permitted by the mailbox's permanentFlags.
    const opts = { uid: true } as const;
    switch (input.operation) {
      case "add":
        return await client.messageFlagsAdd(input.uids, input.flags, opts);
      case "remove":
        return await client.messageFlagsRemove(input.uids, input.flags, opts);
      case "set":
        return await client.messageFlagsSet(input.uids, input.flags, opts);
    }
  } finally {
    lock.release();
  }
}

/** Result of a {@link moveMessages} call. */
export interface MoveResult {
  /** False if the server rejected the move (e.g., non-existent destination). */
  moved: boolean;
  /** Source UID -> destination UID map. Populated when the server supports UIDPLUS (RFC 4315). */
  uidMap: Map<number, number>;
}

/**
 * Move messages from one mailbox to another via IMAP MOVE (RFC 6851).
 *
 * Returns a {@link MoveResult} with a boolean indicating success and a source
 * UID -> destination UID map (populated when the server supports UIDPLUS).
 *
 * Acquires a mailbox lock internally and releases it in a finally block.
 * Connection lifecycle (connect/logout) is the caller's responsibility.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6851 - IMAP MOVE extension
 * @see https://datatracker.ietf.org/doc/html/rfc4315#section-3 - UIDPLUS COPYUID response
 * @see https://imapflow.com/docs/api/imapflow-client#messagemoverange-destination-options
 */
export async function moveMessages(
  client: ImapFlow,
  input: MoveMessagesInput,
): Promise<MoveResult> {
  const lock = await client.getMailboxLock(input.mailbox);
  try {
    if (
      input.expectedUidValidity !== undefined &&
      client.mailbox &&
      Number(client.mailbox.uidValidity) !== input.expectedUidValidity
    ) {
      return { moved: false, uidMap: new Map() };
    }

    // Returns a CopyResponseObject with uidMap on success, or false on
    // server-level rejection (e.g., non-existent destination mailbox).
    const result = await client.messageMove(input.uids, input.destination, { uid: true });
    if (!result) return { moved: false, uidMap: new Map() };
    return { moved: true, uidMap: result.uidMap ?? new Map() };
  } finally {
    lock.release();
  }
}

/**
 * Permanently remove messages via STORE \Deleted + EXPUNGE.
 *
 * This is a pure IMAP primitive. The conditional logic (move to Trash first
 * vs. permanent delete) is the command handler's responsibility.
 *
 * Uses UID EXPUNGE (RFC 4315 §2.1) when the server supports UIDPLUS, so only
 * the specified UIDs are expunged. Falls back to plain EXPUNGE otherwise.
 *
 * Acquires a mailbox lock internally and releases it in a finally block.
 * Connection lifecycle (connect/logout) is the caller's responsibility.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc4315#section-2.1 - UID EXPUNGE
 * @see https://imapflow.com/docs/api/imapflow-client#messagedeleterange-options
 */
export async function expungeMessages(
  client: ImapFlow,
  input: ExpungeMessagesInput,
): Promise<boolean> {
  const lock = await client.getMailboxLock(input.mailbox);
  try {
    if (
      input.expectedUidValidity !== undefined &&
      client.mailbox &&
      Number(client.mailbox.uidValidity) !== input.expectedUidValidity
    ) {
      return false;
    }

    // Returns true when the EXPUNGE command completes (even if no messages
    // matched the UIDs - a no-op is still a successful command). Returns false
    // only on server-level rejection (e.g., read-only mailbox).
    return await client.messageDelete(input.uids, { uid: true });
  } finally {
    lock.release();
  }
}
