import type { DiscoveredMailbox, DiscoveryResult, ImapCredentials } from "./types";

import { withImapConnection } from "./connection";
import { mapMailboxRole } from "./role-map";

/**
 * Connect to IMAP, list mailboxes, role-map, and build hierarchy.
 *
 * @see https://imapflow.com/docs/api/imapflow-client#listoptions
 * @see https://imapflow.com/docs/guides/mailbox-management
 */
export async function discoverMailboxes(creds: ImapCredentials): Promise<DiscoveryResult> {
  return withImapConnection(creds, async (client) => {
    const listed = await client.list();

    const nodesByPath = new Map<string, DiscoveredMailbox>();
    const parentPaths = new Map<string, string | null>();

    for (const entry of listed) {
      // TODO: \Noselect mailboxes are virtual hierarchy containers (e.g.
      // [Gmail]) that can't hold messages. Skipping them means their children
      // become roots. Revisit in case we needed it, e.g., sidebar needs to
      // display provider hierarchy, etc.
      if (entry.flags.has("\\Noselect")) continue;

      const specialUse = entry.specialUse || null;
      const delimiter = entry.delimiter || null;

      nodesByPath.set(entry.path, {
        path: entry.path,
        delimiter,
        role: mapMailboxRole(specialUse, entry.name, delimiter),
        specialUse,
        children: [],
      });

      parentPaths.set(entry.path, entry.parentPath || null);
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
