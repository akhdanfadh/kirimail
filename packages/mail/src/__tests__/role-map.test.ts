import { describe, expect, it } from "vitest";

import { mapMailboxRole } from "../role-map";

describe("mapMailboxRole", () => {
  describe("tier 1: special-use attributes", () => {
    it.each([
      ["\\Inbox", "inbox"],
      ["\\Sent", "sent"],
      ["\\Drafts", "drafts"],
      ["\\Trash", "trash"],
      ["\\Junk", "junk"],
      ["\\Archive", "archive"],
    ] as const)("maps %s to %s", (specialUse, expected) => {
      expect(mapMailboxRole(specialUse, "AnyPath", null)).toBe(expected);
    });

    it("falls through to custom for unmapped attributes", () => {
      expect(mapMailboxRole("\\Flagged", "Flagged", null)).toBe("custom");
    });

    it("special-use takes priority over name pattern", () => {
      expect(mapMailboxRole("\\Trash", "Archive", null)).toBe("trash");
    });
  });

  describe("tier 2: name pattern fallback", () => {
    it.each([
      ["INBOX", "inbox"],
      ["Sent", "sent"],
      ["Sent Items", "sent"],
      ["Sent Mail", "sent"],
      ["Drafts", "drafts"],
      ["Draft", "drafts"],
      ["Trash", "trash"],
      ["Deleted", "trash"],
      ["Deleted Items", "trash"],
      ["Junk", "junk"],
      ["Spam", "junk"],
      ["Junk E-mail", "junk"],
      ["Archive", "archive"],
      ["Archives", "archive"],
    ] as const)("maps '%s' to %s", (path, expected) => {
      expect(mapMailboxRole(null, path, null)).toBe(expected);
    });

    it("matches leaf segment when delimiter is provided", () => {
      expect(mapMailboxRole(null, "[Gmail]/Sent Mail", "/")).toBe("sent");
      expect(mapMailboxRole(null, "INBOX.Drafts", ".")).toBe("drafts");
    });

    it("returns custom for unknown paths", () => {
      expect(mapMailboxRole(null, "Personal", null)).toBe("custom");
      expect(mapMailboxRole(null, "[Gmail]", "/")).toBe("custom");
    });
  });
});
