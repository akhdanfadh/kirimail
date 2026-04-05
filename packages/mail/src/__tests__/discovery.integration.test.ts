import { beforeAll, describe, expect, it } from "vitest";

import { withImapConnection } from "../connection";
import { discoverMailboxes } from "../discovery";
import { seedMessage, testCredentials } from "./setup";

const creds = () => testCredentials("testuser");

describe("discoverMailboxes (Stalwart integration)", () => {
  beforeAll(async () => {
    await seedMessage(creds(), { subject: "Test message for discovery" });
  });

  it("discovers INBOX with role inbox", async () => {
    const result = await discoverMailboxes(creds());

    const inbox = result.mailboxes.find((mb) => mb.role === "inbox");

    expect(inbox).toBeDefined();
    expect(inbox!.path).toBe("INBOX");
  });

  it("includes sync cursor for INBOX", async () => {
    const result = await discoverMailboxes(creds());
    const inbox = result.mailboxes.find((mb) => mb.role === "inbox");

    expect(inbox).toBeDefined();
    expect(inbox!.syncCursor).not.toBeNull();

    const cursor = inbox!.syncCursor!;
    expect(cursor.uidValidity).toBeGreaterThan(0);
    expect(cursor.uidNext).toBeGreaterThan(1);
    expect(cursor.messageCount).toBeGreaterThanOrEqual(1);
    expect(cursor.highestModseq).toBeTypeOf("number");
    expect(cursor.highestModseq!).toBeGreaterThan(0);
  });

  it("reflects increased uidNext after new message delivery", async () => {
    const before = await discoverMailboxes(creds());
    const cursorBefore = before.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    await seedMessage(creds(), { subject: "New message for uidNext test" });

    const after = await discoverMailboxes(creds());
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
    const first = await discoverMailboxes(creds());
    const cursorFirst = first.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    const second = await discoverMailboxes(creds());
    const cursorSecond = second.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    expect(cursorSecond).toEqual(cursorFirst);
  });

  it("reflects decreased messageCount after deletion", async () => {
    const before = await discoverMailboxes(creds());
    const cursorBefore = before.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    // Delete one message via IMAP
    await withImapConnection(creds(), async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageDelete("1", { uid: true });
      } finally {
        lock.release();
      }
    });

    const after = await discoverMailboxes(creds());
    const cursorAfter = after.mailboxes.find((mb) => mb.role === "inbox")!.syncCursor!;

    expect(cursorAfter.messageCount).toBe(cursorBefore.messageCount - 1);
    expect(cursorAfter.uidNext).toBe(cursorBefore.uidNext);
    expect(cursorAfter.uidValidity).toBe(cursorBefore.uidValidity);
  });

  it("throws on invalid credentials", async () => {
    const badCreds = { ...creds(), pass: "wrongpassword" };

    await expect(discoverMailboxes(badCreds)).rejects.toThrow();
  });
});
