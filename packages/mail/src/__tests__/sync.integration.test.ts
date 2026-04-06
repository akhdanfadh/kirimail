import { describe, expect, it } from "vitest";

import { withImapConnection } from "../connection";
import { syncMailbox } from "../sync";
import { seedMessage, testCredentials } from "./setup";

const creds = () => testCredentials("syncuser");

describe("syncMailbox (Stalwart integration)", () => {
  it("full-resyncs on first sync (no stored cursor)", async () => {
    await seedMessage(creds(), { headers: { subject: "Sync test 1" } });
    await seedMessage(creds(), { headers: { subject: "Sync test 2" } });
    await seedMessage(creds(), { headers: { subject: "Sync test 3" } });

    const result = await syncMailbox(creds(), "INBOX", null);

    expect(result.action).toEqual({ type: "full-resync", reason: "no-prior-cursor" });
    expect(result.messages).toHaveLength(3);

    // Newest-first ordering (descending UID)
    expect(result.messages[0]!.uid).toBeGreaterThan(result.messages[1]!.uid);
    expect(result.messages[1]!.uid).toBeGreaterThan(result.messages[2]!.uid);

    for (const msg of result.messages) {
      expect(msg.envelope.subject).toMatch(/^Sync test \d$/);
      expect(msg.envelope.from.length).toBeGreaterThan(0);
      expect(msg.sizeOctets).toBeGreaterThan(0);
      expect(msg.internalDate).toBeInstanceOf(Date);
      expect(msg.flags).toBeInstanceOf(Set);
    }

    expect(result.cursor.uidValidity).toBeGreaterThan(0);
    expect(result.cursor.uidNext).toBeGreaterThan(result.messages[0]!.uid);
    expect(result.cursor.messageCount).toBe(3);
  });

  it("returns only new messages on incremental sync", async () => {
    // INBOX has 3 messages from previous test - capture cursor
    const initial = await syncMailbox(creds(), "INBOX", null);

    await seedMessage(creds(), { headers: { subject: "Incremental 1" } });
    await seedMessage(creds(), { headers: { subject: "Incremental 2" } });

    const incremental = await syncMailbox(creds(), "INBOX", initial.cursor);

    expect(incremental.action.type).toBe("incremental");
    expect(incremental.messages).toHaveLength(2);
    for (const msg of incremental.messages) {
      expect(msg.uid).toBeGreaterThanOrEqual(initial.cursor.uidNext);
      expect(msg.envelope.subject).toMatch(/^Incremental \d$/);
    }
    expect(incremental.cursor.messageCount).toBe(5);
  });

  it("returns noop when nothing changed", async () => {
    const first = await syncMailbox(creds(), "INBOX", null);
    const second = await syncMailbox(creds(), "INBOX", first.cursor);

    expect(second.action).toEqual({ type: "noop" });
    expect(second.messages).toHaveLength(0);
    expect(second.cursor).toEqual(first.cursor);
  });

  it("filters by date on full-resync with since option", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("SyncDateTest"));

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    await seedMessage(creds(), {
      headers: { subject: "Old message 1" },
      mailbox: "SyncDateTest",
      internalDate: sixMonthsAgo,
    });
    await seedMessage(creds(), {
      headers: { subject: "Old message 2" },
      mailbox: "SyncDateTest",
      internalDate: sixMonthsAgo,
    });
    await seedMessage(creds(), {
      headers: { subject: "Recent message 1" },
      mailbox: "SyncDateTest",
      internalDate: yesterday,
    });
    await seedMessage(creds(), {
      headers: { subject: "Recent message 2" },
      mailbox: "SyncDateTest",
      internalDate: yesterday,
    });

    const result = await syncMailbox(creds(), "SyncDateTest", null, { since: threeMonthsAgo });

    expect(result.action.type).toBe("full-resync");
    expect(result.messages).toHaveLength(2);
    for (const msg of result.messages) {
      expect(msg.envelope.subject).toMatch(/^Recent message \d$/);
    }
    // Cursor reflects total mailbox state (all 4 messages), not just fetched
    expect(result.cursor.messageCount).toBe(4);
  });

  it("returns empty messages for empty mailbox", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("EmptyTest"));

    const result = await syncMailbox(creds(), "EmptyTest", null);

    expect(result.action.type).toBe("full-resync");
    expect(result.messages).toHaveLength(0);
    expect(result.cursor.messageCount).toBe(0);
    expect(result.cursor.uidValidity).toBeGreaterThan(0);
  });

  it("preserves IMAP flags", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("FlagTest"));

    await seedMessage(creds(), {
      headers: { subject: "Flagged message" },
      mailbox: "FlagTest",
      flags: ["\\Seen", "\\Flagged"],
    });

    const result = await syncMailbox(creds(), "FlagTest", null);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.flags.has("\\Seen")).toBe(true);
    expect(result.messages[0]!.flags.has("\\Flagged")).toBe(true);
  });

  it("captures envelope threading fields", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("ThreadTest"));

    const parentId = "<parent-001@test.localhost>";
    const replyId = "<reply-001@test.localhost>";

    await seedMessage(creds(), {
      headers: { subject: "Parent message", messageId: parentId },
      mailbox: "ThreadTest",
    });
    await seedMessage(creds(), {
      headers: {
        subject: "Re: Parent message",
        messageId: replyId,
        inReplyTo: parentId,
        references: parentId,
      },
      mailbox: "ThreadTest",
    });

    const result = await syncMailbox(creds(), "ThreadTest", null);

    expect(result.messages).toHaveLength(2);

    // Newest first - reply has higher UID
    const reply = result.messages[0]!;
    const parent = result.messages[1]!;

    expect(parent.envelope.messageId).toBe(parentId);
    expect(reply.envelope.messageId).toBe(replyId);
    expect(reply.envelope.inReplyTo).toBe(parentId);
    expect(reply.references).toContain("parent-001@test.localhost");
  });

  it("full-resyncs when UIDVALIDITY changes (mailbox rebuilt)", async () => {
    // Simulate server rebuilding a mailbox: delete + recreate changes UIDVALIDITY
    await withImapConnection(creds(), (client) => client.mailboxCreate("UidValidityTest"));
    await seedMessage(creds(), {
      headers: { subject: "Before rebuild" },
      mailbox: "UidValidityTest",
    });

    const before = await syncMailbox(creds(), "UidValidityTest", null);
    expect(before.messages).toHaveLength(1);

    // Rebuild: delete and recreate the mailbox
    await withImapConnection(creds(), async (client) => {
      await client.mailboxDelete("UidValidityTest");
      await client.mailboxCreate("UidValidityTest");
    });
    await seedMessage(creds(), {
      headers: { subject: "After rebuild" },
      mailbox: "UidValidityTest",
    });

    const after = await syncMailbox(creds(), "UidValidityTest", before.cursor);

    expect(after.action).toEqual({ type: "full-resync", reason: "uid-validity-changed" });
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.envelope.subject).toBe("After rebuild");
    expect(after.cursor.uidValidity).not.toBe(before.cursor.uidValidity);
  });

  it("signals deletion via additionsOnly: false", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("DeletionTest"));
    await seedMessage(creds(), { headers: { subject: "Keep" }, mailbox: "DeletionTest" });
    await seedMessage(creds(), { headers: { subject: "Delete me" }, mailbox: "DeletionTest" });

    const before = await syncMailbox(creds(), "DeletionTest", null);
    expect(before.messages).toHaveLength(2);

    // Delete one message via IMAP
    const deleteUid = before.messages.find((m) => m.envelope.subject === "Delete me")!.uid;
    await withImapConnection(creds(), async (client) => {
      const lock = await client.getMailboxLock("DeletionTest");
      try {
        await client.messageDelete(String(deleteUid), { uid: true });
      } finally {
        lock.release();
      }
    });

    const after = await syncMailbox(creds(), "DeletionTest", before.cursor);

    expect(after.action.type).toBe("incremental");
    if (after.action.type === "incremental") {
      expect(after.action.newMessages).toBe(false);
      expect(after.action.additionsOnly).toBe(false);
      // flagChanges may be true - deletion increments highestModseq on some servers
    }
    // No new messages to fetch - deletion reconciliation is the caller's job
    expect(after.messages).toHaveLength(0);
    expect(after.cursor.messageCount).toBe(1);
  });
});
