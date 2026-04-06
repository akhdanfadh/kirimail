import type { ImapFlow, MessageAddressObject } from "imapflow";

import type { FetchedMessage, MessageAddress } from "./types";

/**
 * Fetch message metadata from the currently-open mailbox.
 *
 * This is the IMAP-specific data acquisition layer. It handles UID range
 * resolution, ENVELOPE parsing, References header fetching, and address
 * mapping. Internal to the sync pipeline - called by `syncMailbox`.
 *
 * @param client - Connected ImapFlow client with a mailbox already open.
 * @param since - Date-based lookback filter (IMAP SEARCH SINCE).
 * @param uidSince - Only fetch UIDs >= this value (incremental sync).
 */
export async function fetchMessages(
  client: ImapFlow,
  since?: Date,
  uidSince?: number,
): Promise<FetchedMessage[]> {
  if (!client.mailbox) {
    throw new Error("fetchMessages requires a mailbox to be open - call mailboxOpen first");
  }

  // Determine the UID range to fetch based on options
  let range: string;
  if (uidSince != null) {
    range = `${uidSince}:*`;
  } else if (since != null) {
    const uids = await client.search({ since }, { uid: true });
    if (!uids || uids.length === 0) return [];
    range = uids.join(",");
  } else {
    range = "1:*";
  }

  // Fetch messages in the specified UID range with required metadata
  const messages: FetchedMessage[] = [];
  for await (const msg of client.fetch(
    range,
    {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      headers: ["references"], // for threading
    },
    { uid: true },
  )) {
    messages.push({
      uid: msg.uid,
      envelope: {
        date: msg.envelope?.date instanceof Date ? msg.envelope.date : null,
        subject: msg.envelope?.subject ?? null,
        from: mapAddresses(msg.envelope?.from),
        sender: mapAddresses(msg.envelope?.sender),
        replyTo: mapAddresses(msg.envelope?.replyTo),
        to: mapAddresses(msg.envelope?.to),
        cc: mapAddresses(msg.envelope?.cc),
        bcc: mapAddresses(msg.envelope?.bcc),
        inReplyTo: msg.envelope?.inReplyTo ?? null,
        messageId: msg.envelope?.messageId ?? null,
      },
      references: parseHeaderValue(msg.headers, "references"),
      flags: msg.flags ?? new Set(),
      internalDate:
        msg.internalDate instanceof Date ? msg.internalDate : new Date(msg.internalDate as string),
      sizeOctets: msg.size ?? 0,
    });
  }

  // Newest-first: higher UID = more recently received
  messages.sort((a, b) => b.uid - a.uid);
  return messages;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert imapflow addresses (undefined/empty fields) to our type (null fields). */
function mapAddresses(addrs: MessageAddressObject[] | undefined): MessageAddress[] {
  if (!addrs) return [];
  // Use || to coerce empty strings to null (imapflow returns "" for group syntax markers)
  return addrs.map((a) => ({ name: a.name || null, address: a.address || null }));
}

/**
 * Extract a single header value from a raw RFC 5322 header buffer.
 * Multi-line values (folded headers) are unfolded before returning.
 */
export function parseHeaderValue(buf: Buffer | undefined, name: string): string | null {
  if (!buf || buf.length === 0) return null;
  const text = buf.toString("utf-8");
  // Header name is case-insensitive; value may be folded across lines
  const re = new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t]+.+)*)`, "im");
  const match = re.exec(text);
  if (!match) return null;
  // Unfold: replace CRLF + whitespace with a single space
  return match[1]!.replace(/\r?\n[ \t]+/g, " ").trim();
}
