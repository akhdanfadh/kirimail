import { describe, expect, it } from "vitest";

import { mapMailboxRole, shouldAppendToSent } from "../discovery";

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

describe("shouldAppendToSent", () => {
  const gmailCaps = new Map<string, boolean | number>([
    ["IMAP4rev1", true],
    ["X-GM-EXT-1", true],
  ]);
  const plainCaps = new Map<string, boolean | number>([["IMAP4rev1", true]]);

  it("returns false for Gmail (X-GM-EXT-1 + \\All mailbox) - server auto-copies", () => {
    expect(
      shouldAppendToSent({
        imapHost: "imap.gmail.com",
        capabilities: gmailCaps,
        hasAllMailbox: true,
      }),
    ).toBe(false);
  });

  it("returns true when X-GM-EXT-1 is present but \\All mailbox is absent", () => {
    // X-GM-EXT-1 alone is insufficient - Sent auto-copy is tied to the \All
    // folder existing, not just the capability being advertised.
    expect(
      shouldAppendToSent({
        imapHost: "imap.gmail.com",
        capabilities: gmailCaps,
        hasAllMailbox: false,
      }),
    ).toBe(true);
  });

  it("returns true when \\All is present but X-GM-EXT-1 is absent", () => {
    expect(
      shouldAppendToSent({
        imapHost: "imap.example.com",
        capabilities: plainCaps,
        hasAllMailbox: true,
      }),
    ).toBe(true);
  });

  it("returns false for Outlook via office365.com host regardless of capabilities", () => {
    expect(
      shouldAppendToSent({
        imapHost: "outlook.office365.com",
        capabilities: plainCaps,
        hasAllMailbox: false,
      }),
    ).toBe(false);
  });

  it("host match is case-insensitive", () => {
    expect(
      shouldAppendToSent({
        imapHost: "outlook.Office365.COM",
        capabilities: plainCaps,
        hasAllMailbox: false,
      }),
    ).toBe(false);
  });

  it("requires the host to end with office365.com (rejects suffixed domains)", () => {
    expect(
      shouldAppendToSent({
        imapHost: "office365.com.example.com",
        capabilities: plainCaps,
        hasAllMailbox: false,
      }),
    ).toBe(true);
  });

  it("requires a word boundary before office365.com (rejects glued prefixes)", () => {
    // Without `\b`, `fakeoffice365.com` would match. Guards against vanity
    // domains that happen to end in the literal substring.
    expect(
      shouldAppendToSent({
        imapHost: "fakeoffice365.com",
        capabilities: plainCaps,
        hasAllMailbox: false,
      }),
    ).toBe(true);
  });

  it("returns true for self-hosted IMAP servers (Stalwart, Dovecot, etc.)", () => {
    expect(
      shouldAppendToSent({
        imapHost: "mail.myserver.com",
        capabilities: plainCaps,
        hasAllMailbox: false,
      }),
    ).toBe(true);
  });
});
