import { describe, expect, it } from "vitest";

import type { SyncMailboxesOptions, SyncMailboxResult, SyncCursor } from "../types";

import { withImapConnection } from "../connection";
import { syncMailboxes } from "../sync";
import { seedMessage, testCredentials } from "./setup";

const creds = () => testCredentials("syncuser");

/** Sync a single mailbox via syncMailboxes - test convenience. */
async function syncOne(
  path: string,
  storedCursor: SyncCursor | null,
  options?: SyncMailboxesOptions,
): Promise<SyncMailboxResult> {
  const { results, errors } = await syncMailboxes(creds(), [{ path, storedCursor }], options);
  if (errors.has(path)) throw errors.get(path);
  return results.get(path)!;
}

describe("syncMailboxes", () => {
  it("full-resyncs on first sync (no stored cursor)", async () => {
    await seedMessage(creds(), { headers: { subject: "Sync test 1" } });
    await seedMessage(creds(), { headers: { subject: "Sync test 2" } });
    await seedMessage(creds(), { headers: { subject: "Sync test 3" } });

    const result = await syncOne("INBOX", null);

    expect(result.action).toEqual({ type: "full-resync", reason: "no-prior-cursor" });
    expect(result.messages).toHaveLength(3);
    expect(result.remoteUids).toBeNull();

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
    const initial = await syncOne("INBOX", null);

    await seedMessage(creds(), { headers: { subject: "Incremental 1" } });
    await seedMessage(creds(), { headers: { subject: "Incremental 2" } });

    const incremental = await syncOne("INBOX", initial.cursor);

    expect(incremental.action.type).toBe("incremental");
    expect(incremental.messages).toHaveLength(2);
    expect(incremental.remoteUids).toBeNull();
    for (const msg of incremental.messages) {
      expect(msg.uid).toBeGreaterThanOrEqual(initial.cursor.uidNext);
      expect(msg.envelope.subject).toMatch(/^Incremental \d$/);
    }
    expect(incremental.cursor.messageCount).toBe(5);
  });

  it("returns noop when nothing changed", async () => {
    const first = await syncOne("INBOX", null);
    const second = await syncOne("INBOX", first.cursor);

    expect(second.action).toEqual({ type: "noop" });
    expect(second.messages).toHaveLength(0);
    expect(second.remoteUids).toBeNull();
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

    const result = await syncOne("SyncDateTest", null, { since: threeMonthsAgo });

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

    const result = await syncOne("EmptyTest", null);

    expect(result.action.type).toBe("full-resync");
    expect(result.messages).toHaveLength(0);
    expect(result.remoteUids).toEqual([]);
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

    const result = await syncOne("FlagTest", null);

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

    const result = await syncOne("ThreadTest", null);

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

    const before = await syncOne("UidValidityTest", null);
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

    const after = await syncOne("UidValidityTest", before.cursor);

    expect(after.action).toEqual({ type: "full-resync", reason: "uid-validity-changed" });
    expect(after.messages).toHaveLength(1);
    expect(after.remoteUids).toBeNull();
    expect(after.messages[0]!.envelope.subject).toBe("After rebuild");
    expect(after.cursor.uidValidity).not.toBe(before.cursor.uidValidity);
  });

  it("returns empty remoteUids when all messages deleted from synced mailbox", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("EmptyAfterSync"));
    await seedMessage(creds(), { headers: { subject: "Doomed 1" }, mailbox: "EmptyAfterSync" });
    await seedMessage(creds(), { headers: { subject: "Doomed 2" }, mailbox: "EmptyAfterSync" });

    const before = await syncOne("EmptyAfterSync", null);
    expect(before.messages).toHaveLength(2);

    // Delete all messages via IMAP
    await withImapConnection(creds(), async (client) => {
      const lock = await client.getMailboxLock("EmptyAfterSync");
      try {
        await client.messageDelete("1:*", { uid: true });
      } finally {
        lock.release();
      }
    });

    const after = await syncOne("EmptyAfterSync", before.cursor);

    expect(after.action.type).toBe("incremental");
    if (after.action.type === "incremental") {
      expect(after.action.additionsOnly).toBe(false);
    }
    expect(after.messages).toHaveLength(0);
    expect(after.cursor.messageCount).toBe(0);
    // Empty array (not null) signals "delete everything" to DB layer.
    // Hits the mailbox.exists === 0 early return, skipping SEARCH ALL.
    expect(after.remoteUids).toEqual([]);
  });

  it("returns remoteUids when deletions detected alongside new messages", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("DeletionWithAdd"));
    await seedMessage(creds(), { headers: { subject: "Msg A" }, mailbox: "DeletionWithAdd" });
    await seedMessage(creds(), { headers: { subject: "Msg B" }, mailbox: "DeletionWithAdd" });
    await seedMessage(creds(), { headers: { subject: "Msg C" }, mailbox: "DeletionWithAdd" });

    const before = await syncOne("DeletionWithAdd", null);
    expect(before.messages).toHaveLength(3);

    // Delete Msg B via IMAP
    const deleteUid = before.messages.find((m) => m.envelope.subject === "Msg B")!.uid;
    await withImapConnection(creds(), async (client) => {
      const lock = await client.getMailboxLock("DeletionWithAdd");
      try {
        await client.messageDelete(String(deleteUid), { uid: true });
      } finally {
        lock.release();
      }
    });

    // Add a new message
    await seedMessage(creds(), { headers: { subject: "Msg D" }, mailbox: "DeletionWithAdd" });

    const after = await syncOne("DeletionWithAdd", before.cursor);

    expect(after.action.type).toBe("incremental");
    if (after.action.type === "incremental") {
      expect(after.action.newMessages).toBe(true);
      expect(after.action.additionsOnly).toBe(false);
    }

    // New message fetched
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.envelope.subject).toBe("Msg D");

    // remoteUids contains surviving + new UIDs, not the deleted one
    const uidA = before.messages.find((m) => m.envelope.subject === "Msg A")!.uid;
    const uidC = before.messages.find((m) => m.envelope.subject === "Msg C")!.uid;
    const uidD = after.messages[0]!.uid;
    expect(after.remoteUids).not.toBeNull();
    expect(after.remoteUids).toHaveLength(3);
    expect(after.remoteUids).toEqual(expect.arrayContaining([uidA, uidC, uidD]));
    expect(after.remoteUids).not.toContain(deleteUid);
  });

  it("signals deletion via additionsOnly: false", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("DeletionTest"));
    await seedMessage(creds(), { headers: { subject: "Keep" }, mailbox: "DeletionTest" });
    await seedMessage(creds(), { headers: { subject: "Delete me" }, mailbox: "DeletionTest" });

    const before = await syncOne("DeletionTest", null);
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

    const after = await syncOne("DeletionTest", before.cursor);

    expect(after.action.type).toBe("incremental");
    if (after.action.type === "incremental") {
      expect(after.action.newMessages).toBe(false);
      expect(after.action.additionsOnly).toBe(false);
      // flagChanges may be true - deletion increments highestModseq on some servers
    }
    // No new messages to fetch
    expect(after.messages).toHaveLength(0);
    expect(after.cursor.messageCount).toBe(1);

    // remoteUids contains only the surviving message's UID
    const keepUid = before.messages.find((m) => m.envelope.subject === "Keep")!.uid;
    expect(after.remoteUids).not.toBeNull();
    expect(after.remoteUids).toHaveLength(1);
    expect(after.remoteUids).toContain(keepUid);
    expect(after.remoteUids).not.toContain(deleteUid);
  });

  it("syncs multiple mailboxes on a shared connection with isolated results", async () => {
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate("MultiA");
      await client.mailboxCreate("MultiB");
    });

    await seedMessage(creds(), { headers: { subject: "A-1" }, mailbox: "MultiA" });
    await seedMessage(creds(), { headers: { subject: "A-2" }, mailbox: "MultiA" });
    await seedMessage(creds(), { headers: { subject: "B-1" }, mailbox: "MultiB" });

    const { results, errors } = await syncMailboxes(creds(), [
      { path: "MultiA", storedCursor: null },
      { path: "MultiB", storedCursor: null },
    ]);

    expect(errors.size).toBe(0);
    expect(results.size).toBe(2);

    const a = results.get("MultiA")!;
    expect(a.messages).toHaveLength(2);
    expect(a.messages.map((m) => m.envelope.subject).sort()).toEqual(["A-1", "A-2"]);
    expect(a.cursor.messageCount).toBe(2);

    const b = results.get("MultiB")!;
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]!.envelope.subject).toBe("B-1");
    expect(b.cursor.messageCount).toBe(1);
  });

  it("skips nonexistent mailbox and continues syncing remaining mailboxes", async () => {
    await withImapConnection(creds(), (client) => client.mailboxCreate("ExistsOk"));
    await seedMessage(creds(), { headers: { subject: "Survivor" }, mailbox: "ExistsOk" });

    const { results, errors } = await syncMailboxes(creds(), [
      { path: "DoesNotExist", storedCursor: null },
      { path: "ExistsOk", storedCursor: null },
    ]);

    // Nonexistent mailbox produces an error, not a crash
    expect(errors.size).toBe(1);
    expect(errors.has("DoesNotExist")).toBe(true);

    // Remaining mailbox synced successfully
    expect(results.size).toBe(1);
    const ok = results.get("ExistsOk")!;
    expect(ok.messages).toHaveLength(1);
    expect(ok.messages[0]!.envelope.subject).toBe("Survivor");
  });
});
