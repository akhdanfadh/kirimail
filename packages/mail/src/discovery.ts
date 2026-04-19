import type { DiscoveredMailbox, SyncCursor, MailboxRole } from "@kirimail/shared";

import type { ImapCredentials } from "./connection";

import { withImapConnection } from "./connection";

const SPECIAL_USE_MAP: Record<string, MailboxRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
  "\\All": "all",
};

const NAME_PATTERN_MAP: Array<[string[], MailboxRole]> = [
  [["inbox"], "inbox"],
  [
    [
      "sent",
      "sent items", // Outlook?
      "sent mail", // Gmail?
    ],
    "sent",
  ],
  [["drafts", "draft"], "drafts"],
  [
    [
      "trash",
      "deleted",
      "deleted items", // Outlook?
    ],
    "trash",
  ],
  [
    [
      "junk",
      "spam", // Gmail?
      "junk e-mail", // Outlook?
    ],
    "junk",
  ],
  [["archive", "archives"], "archive"],
  [["all mail"], "all"],
];

/**
 * Determine the normalized role for a mailbox.
 * Tier 1: special-use attribute from IMAP LIST (authoritative).
 * Tier 2: case-insensitive name pattern match on leaf segment.
 */
export function mapMailboxRole(
  specialUse: string | null,
  path: string,
  delimiter: string | null,
): MailboxRole {
  if (specialUse) {
    const role = SPECIAL_USE_MAP[specialUse];
    if (role) return role;
  }

  const leaf = delimiter ? path.split(delimiter).pop()! : path;
  const normalized = leaf.toLowerCase();

  for (const [patterns, role] of NAME_PATTERN_MAP) {
    if (patterns.includes(normalized)) return role;
  }

  return "custom";
}

/**
 * True when the worker (caller) should APPEND to the Sent folder after
 * SMTP delivery; false when the provider auto-copies server-side (Gmail,
 * Outlook), where an explicit APPEND would duplicate.
 *
 * Mirrors EmailEngine's `isGmail` / `isOutlook` heuristics.
 *
 * @see https://github.com/postalsys/emailengine/blob/master/lib/email-client/imap-client.js - `this.isGmail` / `this.isOutlook`
 */
export function shouldAppendToSent(opts: {
  imapHost: string;
  /** imapflow's `client.capabilities`. */
  capabilities: Map<string, boolean | number>;
  hasAllMailbox: boolean;
}): boolean {
  if (opts.capabilities.has("X-GM-EXT-1") && opts.hasAllMailbox) return false;
  // NOTE: Host-only heuristic - misses on-prem Exchange and vanity domains.
  // Also false-negatives on delegated accounts (auto-copy lands in the owner's
  // Sent, not the delegate's, so APPEND is still required); harmless until we
  // add delegation.
  if (/\boffice365\.com$/i.test(opts.imapHost)) return false;
  return true;
}

/** Result of mailbox discovery for an IMAP account. */
export interface DiscoveryResult {
  /** Root-level mailboxes; descendants are nested via {@link DiscoveredMailbox.children}. */
  mailboxes: DiscoveredMailbox[];
  /**
   * Whether the worker (caller) should APPEND to the Sent folder after SMTP delivery.
   * False for providers that auto-copy server-side (Gmail, Outlook).
   */
  appendToSent: boolean;
}

/**
 * Connect to IMAP, list mailboxes with sync cursors, role-map, and build hierarchy.
 *
 * @see https://imapflow.com/docs/api/imapflow-client#listoptions
 * @see https://imapflow.com/docs/guides/mailbox-management
 */
export async function discoverMailboxes(creds: ImapCredentials): Promise<DiscoveryResult> {
  return withImapConnection(creds, async (client) => {
    const listed = await client.list({
      statusQuery: {
        messages: true,
        uidNext: true,
        uidValidity: true,
        highestModseq: true,
      },
    });

    const nodesByPath = new Map<string, DiscoveredMailbox>();
    const parentPaths = new Map<string, string | null>();
    let hasAllMailbox = false;

    for (const entry of listed) {
      // Probe \All before the Noselect skip - defensive against servers that
      // flag the All-mail folder as Noselect; we still want the provider signal.
      if (entry.specialUse === "\\All") hasAllMailbox = true;

      // NOTE: \Noselect mailboxes are virtual hierarchy containers (e.g. [Gmail])
      // that can't hold messages. Skipping them means their children become
      // roots. Revisit if, e.g., sidebar needs to display provider hierarchy.
      if (entry.flags.has("\\Noselect")) continue;

      const path = entry.path;
      const specialUse = entry.specialUse || null;
      const delimiter = entry.delimiter || null;
      const status = entry.status;
      const syncCursor: SyncCursor | null =
        // null cursor when incomplete; compareSyncCursors treats this as needing full resync
        status?.uidValidity != null && status.uidNext != null && status.messages != null
          ? {
              uidValidity: Number(status.uidValidity),
              uidNext: status.uidNext,
              highestModseq: status.highestModseq != null ? Number(status.highestModseq) : null,
              messageCount: status.messages,
            }
          : null;

      nodesByPath.set(path, {
        path,
        delimiter,
        specialUse,
        syncCursor,
        role: mapMailboxRole(specialUse, entry.name, delimiter),
        children: [],
      });

      parentPaths.set(path, entry.parentPath || null);
    }

    const roots: DiscoveredMailbox[] = [];

    for (const node of nodesByPath.values()) {
      const parentPath = parentPaths.get(node.path) ?? null;

      if (parentPath && nodesByPath.has(parentPath)) {
        nodesByPath.get(parentPath)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return {
      mailboxes: roots,
      appendToSent: shouldAppendToSent({
        imapHost: creds.host,
        capabilities: client.capabilities,
        hasAllMailbox,
      }),
    };
  });
}
