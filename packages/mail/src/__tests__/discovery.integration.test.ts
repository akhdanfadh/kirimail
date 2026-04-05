import { createTransport } from "nodemailer";
import { beforeAll, describe, expect, inject, it } from "vitest";

import type { ImapCredentials } from "../types";

import { withImapConnection } from "../connection";
import { discoverMailboxes } from "../discovery";

function getTestCredentials(): ImapCredentials {
  return {
    host: inject("greenmailHost"),
    port: inject("greenmailImapPort"),
    secure: false,
    user: "testuser",
    pass: "testpass",
  };
}

async function seedMessage() {
  const transport = createTransport({
    host: inject("greenmailHost"),
    port: inject("greenmailSmtpPort"),
    secure: false,
  });
  await transport.sendMail({
    from: "sender@localhost",
    to: "testuser@localhost",
    subject: "Test message for discovery",
    text: "Hello from the integration test.",
  });
}

describe("discoverMailboxes (GreenMail integration)", () => {
  beforeAll(async () => {
    await seedMessage();
  });

  it("discovers INBOX with role inbox", async () => {
    const result = await discoverMailboxes(getTestCredentials());

    const inbox = result.mailboxes.find((mb) => mb.role === "inbox");

    expect(inbox).toBeDefined();
    expect(inbox!.path).toBe("INBOX");
  });

  it("includes sync cursor for INBOX", async () => {
    const result = await discoverMailboxes(getTestCredentials());
    const inbox = result.mailboxes.find((mb) => mb.role === "inbox");

    expect(inbox).toBeDefined();
    expect(inbox!.syncCursor).not.toBeNull();

    const cursor = inbox!.syncCursor!;
    expect(cursor.uidValidity).toBeGreaterThan(0);
    expect(cursor.uidNext).toBeGreaterThan(1);
    expect(cursor.messageCount).toBeGreaterThanOrEqual(1);
    // GreenMail does not support CONDSTORE (RFC 4551)
    expect(cursor.highestModseq).toBeNull();
  });

  it("reflects increased uidNext after new message delivery", async () => {
    const before = await discoverMailboxes(getTestCredentials());
    const cursorBefore = before.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    await seedMessage();

    const after = await discoverMailboxes(getTestCredentials());
    const cursorAfter = after.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    expect(cursorAfter.uidNext).toBeGreaterThan(cursorBefore.uidNext);
    expect(cursorAfter.messageCount).toBeGreaterThan(cursorBefore.messageCount);
    expect(cursorAfter.uidValidity).toBe(cursorBefore.uidValidity);

    // Balanced-math: one message seeded, both diffs should equal 1
    const uidNextDiff = cursorAfter.uidNext - cursorBefore.uidNext;
    const messageCountDiff = cursorAfter.messageCount - cursorBefore.messageCount;
    expect(uidNextDiff).toBe(messageCountDiff);
  });

  it("returns stable cursor when no changes occurred", async () => {
    const first = await discoverMailboxes(getTestCredentials());
    const cursorFirst = first.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    const second = await discoverMailboxes(getTestCredentials());
    const cursorSecond = second.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    expect(cursorSecond).toEqual(cursorFirst);
  });

  it("reflects decreased messageCount after deletion", async () => {
    const before = await discoverMailboxes(getTestCredentials());
    const cursorBefore = before.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    // Delete one message via IMAP
    await withImapConnection(getTestCredentials(), async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageDelete("1", { uid: true });
      } finally {
        lock.release();
      }
    });

    const after = await discoverMailboxes(getTestCredentials());
    const cursorAfter = after.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    expect(cursorAfter.messageCount).toBe(cursorBefore.messageCount - 1);
    expect(cursorAfter.uidNext).toBe(cursorBefore.uidNext);
    expect(cursorAfter.uidValidity).toBe(cursorBefore.uidValidity);
  });

  it("throws on invalid credentials", async () => {
    const creds: ImapCredentials = {
      ...getTestCredentials(),
      pass: "wrongpassword",
    };

    await expect(discoverMailboxes(creds)).rejects.toThrow();
  });
});
