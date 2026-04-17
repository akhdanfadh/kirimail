/** A message's threading fields as stored in the DB (headerMessageId + references). */
export interface ReferencedMessage {
  /** Angle-bracketed Message-ID (e.g., `<uuid@domain>`). */
  messageId: string;
  /**
   * Space-separated chain of angle-bracketed Message-IDs, or undefined if none.
   * Trusted from DB - parsed from IMAP ENVELOPE by imapflow. No format
   * validation is performed (unlike messageId) because validating each ID
   * in a potentially long chain adds cost without value at this internal boundary.
   */
  references?: string;
}

/**
 * Build In-Reply-To and References headers for a reply.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.4
 */
export function buildReplyHeaders(referenced: ReferencedMessage): {
  inReplyTo: string;
  references: string;
} {
  assertMessageId(referenced.messageId);
  return {
    inReplyTo: referenced.messageId,
    references: buildReferencesChain(referenced),
  };
}

/**
 * Build References header for a forward.
 *
 * Forwards set References to maintain thread linkage. Some clients
 * (Gmail) use this to keep forwards visible in the original thread.
 */
export function buildForwardHeaders(referenced: ReferencedMessage): {
  references: string;
} {
  assertMessageId(referenced.messageId);
  return {
    references: buildReferencesChain(referenced),
  };
}

/**
 * Append the referenced message's ID to its existing References chain.
 *
 * NOTE: The chain grows by one Message-ID per reply. Revisit if providers
 * reject messages with very long References headers.
 */
function buildReferencesChain(referenced: ReferencedMessage): string {
  if (referenced.references) {
    return `${referenced.references.trim()} ${referenced.messageId}`;
  }
  return referenced.messageId;
}

// Loose shape validator: angle-bracketed, one "@", non-empty sides, no
// whitespace. Does NOT enforce dot-atom-text - legacy MUAs emit quoted-
// string local-parts we must still accept for reply/forward. Whitespace
// rejection matters because nodemailer silently strips internal spaces
// in References/In-Reply-To (mime-node _encodeHeaderValue), so "<a b@c>"
// would ship as "<ab@c>" and break the recipient's thread-match.
const MESSAGE_ID_PATTERN = /^<[^<>@\s]+@[^<>@\s]+>$/;

/**
 * Verify that a Message-ID matches the shape encoded in
 * {@link MESSAGE_ID_PATTERN}. Throws on violation.
 */
export function assertMessageId(messageId: string): void {
  if (!messageId || !MESSAGE_ID_PATTERN.test(messageId)) {
    throw new Error(
      `messageId must be angle-bracketed with non-empty id-left and id-right, ` +
        `no whitespace or control chars (e.g., "<id@domain>"), got: ${JSON.stringify(messageId)}`,
    );
  }
}
