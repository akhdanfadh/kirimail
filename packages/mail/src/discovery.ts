import type { DiscoveredMailbox, DiscoveryResult, ImapCredentials, SyncCursor } from "./types";

import { withImapConnection } from "./connection";
import { mapMailboxRole } from "./role-map";

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

    for (const entry of listed) {
      // \Noselect mailboxes are virtual hierarchy containers (e.g. [Gmail])
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

    return { mailboxes: roots };
  });
}
