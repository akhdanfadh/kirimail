import type { MailboxRole } from "./types";

const SPECIAL_USE_MAP: Record<string, MailboxRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
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
