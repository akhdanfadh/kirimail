import { describe, expect, it } from "vitest";

import {
  appendMessage,
  expungeMessages,
  ImapPrimitiveNonRetriableError,
  moveMessages,
  storeFlags,
} from "../commands";
import { withImapConnection } from "../connection";
import { seedMessage, testCredentials } from "./setup";

const creds = () => testCredentials("commandsuser");

/** Fetch flags for a single UID in a mailbox via IMAP read-back. */
async function fetchFlags(mailbox: string, uid: number): Promise<Set<string>> {
  return withImapConnection(creds(), async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { flags: true }, { uid: true });
      if (!msg) throw new Error(`UID ${uid} not found`);
      return msg.flags ?? new Set();
    } finally {
      lock.release();
    }
  });
}

/** Get all UIDs in a mailbox via SEARCH ALL. */
async function getUids(mailbox: string): Promise<number[]> {
  return withImapConnection(creds(), async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return (await client.search({ all: true }, { uid: true })) || [];
    } finally {
      lock.release();
    }
  });
}

describe("storeFlags", () => {
  it("adds \\Seen to an unseen message", async () => {
    const mailbox = "StoreFlagsAddSeen";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox });

    const [uid] = await getUids(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [uid!], flags: ["\\Seen"], operation: "add" }),
    );

    expect(result.ok).toBe(true);
    const flags = await fetchFlags(mailbox, uid!);
    expect(flags.has("\\Seen")).toBe(true);
  });

  it("removes \\Seen from a seen message", async () => {
    const mailbox = "StoreFlagsRemoveSeen";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, flags: ["\\Seen"] });

    const [uid] = await getUids(mailbox);

    await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [uid!], flags: ["\\Seen"], operation: "remove" }),
    );

    const flags = await fetchFlags(mailbox, uid!);
    expect(flags.has("\\Seen")).toBe(false);
  });

  it("sets flags, replacing existing flags", async () => {
    const mailbox = "StoreFlagsSet";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, flags: ["\\Seen", "\\Flagged"] });

    const [uid] = await getUids(mailbox);

    await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [uid!], flags: ["\\Draft"], operation: "set" }),
    );

    const flags = await fetchFlags(mailbox, uid!);
    expect(flags.has("\\Draft")).toBe(true);
    expect(flags.has("\\Seen")).toBe(false);
    expect(flags.has("\\Flagged")).toBe(false);
  });

  it("preserves existing flags when adding", async () => {
    const mailbox = "StoreFlagsPreserve";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, flags: ["\\Seen"] });

    const [uid] = await getUids(mailbox);

    await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [uid!], flags: ["\\Flagged"], operation: "add" }),
    );

    const flags = await fetchFlags(mailbox, uid!);
    expect(flags.has("\\Seen")).toBe(true);
    expect(flags.has("\\Flagged")).toBe(true);
  });

  it("set with empty flags clears all flags", async () => {
    const mailbox = "StoreFlagsClearAll";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, flags: ["\\Seen", "\\Flagged"] });

    const [uid] = await getUids(mailbox);

    await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [uid!], flags: [], operation: "set" }),
    );

    const flags = await fetchFlags(mailbox, uid!);
    expect(flags.size).toBe(0);
  });

  it("works with keyword (non-system) flags", async () => {
    const mailbox = "StoreFlagsKeyword";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox });

    const [uid] = await getUids(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [uid!], flags: ["$label1"], operation: "add" }),
    );

    expect(result.ok).toBe(true);
    const flags = await fetchFlags(mailbox, uid!);
    expect(flags.has("$label1")).toBe(true);
  });

  it("accepts UID range string", async () => {
    const mailbox = "StoreFlagsRange";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, headers: { subject: "R1" } });
    await seedMessage(creds(), { mailbox, headers: { subject: "R2" } });

    await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: "1:*", flags: ["\\Seen"], operation: "add" }),
    );

    const uids = await getUids(mailbox);
    for (const uid of uids) {
      const flags = await fetchFlags(mailbox, uid!);
      expect(flags.has("\\Seen")).toBe(true);
    }
  });

  it("rejects when expectedUidValidity does not match (mailbox rebuilt)", async () => {
    const mailbox = "StoreFlagsUidValidity";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox });

    const oldValidity = await withImapConnection(creds(), async (client) => {
      const status = await client.status(mailbox, { uidValidity: true });
      return Number(status.uidValidity);
    });

    // Rebuild mailbox - UIDVALIDITY changes, UIDs reset
    await withImapConnection(creds(), async (client) => {
      await client.mailboxDelete(mailbox);
      await client.mailboxCreate(mailbox);
    });
    await seedMessage(creds(), { mailbox, headers: { subject: "New occupant" } });

    const newValidity = await withImapConnection(creds(), async (client) => {
      const status = await client.status(mailbox, { uidValidity: true });
      return Number(status.uidValidity);
    });
    expect(newValidity).not.toBe(oldValidity);

    const [uid] = await getUids(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      storeFlags(client, {
        mailbox,
        uids: [uid!],
        flags: ["\\Seen"],
        operation: "add",
        expectedUidValidity: oldValidity,
      }),
    );

    expect(result).toEqual({ ok: false, reason: "uid-validity-stale" });

    // Message untouched
    const flags = await fetchFlags(mailbox, uid!);
    expect(flags.has("\\Seen")).toBe(false);
  });
});

describe("moveMessages", () => {
  it("moves a message and returns correct uidMap", async () => {
    const source = "MoveSource";
    const dest = "MoveDest";
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate(source);
      await client.mailboxCreate(dest);
    });
    await seedMessage(creds(), { mailbox: source });

    const [sourceUid] = await getUids(source);

    const result = await withImapConnection(creds(), (client) =>
      moveMessages(client, { mailbox: source, destination: dest, uids: [sourceUid!] }),
    );

    if (!result.ok) expect.fail("expected ok");
    expect(result.uidMap.size).toBe(1);
    expect(result.uidMap.has(sourceUid!)).toBe(true);

    // Verify actual mailbox state matches the reported result
    const sourceUids = await getUids(source);
    const destUids = await getUids(dest);
    expect(sourceUids).toHaveLength(0);
    expect(destUids).toHaveLength(1);
    expect(result.uidMap.get(sourceUid!)).toBe(destUids[0]);
  });

  it("preserves flags after move", async () => {
    const source = "MoveFlagsSource";
    const dest = "MoveFlagsDest";
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate(source);
      await client.mailboxCreate(dest);
    });
    await seedMessage(creds(), { mailbox: source, flags: ["\\Seen", "\\Flagged"] });

    const [uid] = await getUids(source);

    const result = await withImapConnection(creds(), (client) =>
      moveMessages(client, { mailbox: source, destination: dest, uids: [uid!] }),
    );

    if (!result.ok) expect.fail("expected ok");
    const destUid = result.uidMap.get(uid!);
    expect(destUid).toBeDefined();
    const flags = await fetchFlags(dest, destUid!);
    expect(flags.has("\\Seen")).toBe(true);
    expect(flags.has("\\Flagged")).toBe(true);
  });

  it("accepts UID range string", async () => {
    const source = "MoveRangeSource";
    const dest = "MoveRangeDest";
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate(source);
      await client.mailboxCreate(dest);
    });
    await seedMessage(creds(), { mailbox: source, headers: { subject: "Range 1" } });
    await seedMessage(creds(), { mailbox: source, headers: { subject: "Range 2" } });

    const result = await withImapConnection(creds(), (client) =>
      moveMessages(client, { mailbox: source, destination: dest, uids: "1:*" }),
    );

    if (!result.ok) expect.fail("expected ok");
    expect(result.uidMap.size).toBe(2);
    const sourceUids = await getUids(source);
    const destUids = await getUids(dest);
    expect(sourceUids).toHaveLength(0);
    expect(destUids).toHaveLength(2);
  });

  it("throws when destination does not exist (imapflow swallows server NO)", async () => {
    const source = "MoveNoDestSource";
    await withImapConnection(creds(), (client) => client.mailboxCreate(source));
    await seedMessage(creds(), { mailbox: source });

    const [uid] = await getUids(source);

    await expect(
      withImapConnection(creds(), (client) =>
        moveMessages(client, { mailbox: source, destination: "NoSuchMailbox", uids: [uid!] }),
      ),
    ).rejects.toThrow(ImapPrimitiveNonRetriableError);

    // Source message still exists (server rejected the move)
    const remaining = await getUids(source);
    expect(remaining).toHaveLength(1);
  });

  it("succeeds with empty uidMap for non-existent source UID", async () => {
    const source = "MoveGhostSource";
    const dest = "MoveGhostDest";
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate(source);
      await client.mailboxCreate(dest);
    });
    await seedMessage(creds(), { mailbox: source });

    const [realUid] = await getUids(source);

    // Use a UID that doesn't exist - simulates a race where another client
    // already moved/deleted the message between our UID fetch and MOVE.
    const ghostUid = realUid! + 1000;
    const result = await withImapConnection(creds(), (client) =>
      moveMessages(client, { mailbox: source, destination: dest, uids: [ghostUid] }),
    );

    // Server accepts the command (no error), but nothing actually moved
    if (!result.ok) expect.fail("expected ok");
    expect(result.uidMap.size).toBe(0);

    // Original message still in source, nothing in dest
    const sourceUids = await getUids(source);
    const destUids = await getUids(dest);
    expect(sourceUids).toHaveLength(1);
    expect(destUids).toHaveLength(0);
  });

  it("returns stale-uid-validity when expectedUidValidity does not match", async () => {
    // Guard mechanism is exercised end-to-end (with a real UIDVALIDITY
    // change) in the storeFlags rebuild test. Here we just verify the
    // guard is wired into moveMessages.
    const source = "MoveStaleSource";
    const dest = "MoveStaleDest";
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate(source);
      await client.mailboxCreate(dest);
    });
    await seedMessage(creds(), { mailbox: source });

    const [uid] = await getUids(source);
    const result = await withImapConnection(creds(), (client) =>
      moveMessages(client, {
        mailbox: source,
        destination: dest,
        uids: [uid!],
        expectedUidValidity: 1, // Stalwart-assigned UIDVALIDITY won't be 1
      }),
    );

    expect(result).toEqual({ ok: false, reason: "uid-validity-stale" });
    // Message untouched
    const remaining = await getUids(source);
    expect(remaining).toHaveLength(1);
  });
});

describe("expungeMessages", () => {
  it("permanently removes a message", async () => {
    const mailbox = "ExpungeSingle";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox });

    const [uid] = await getUids(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      expungeMessages(client, { mailbox, uids: [uid!] }),
    );

    expect(result.ok).toBe(true);
    const remaining = await getUids(mailbox);
    expect(remaining).toHaveLength(0);
  });

  it("returns stale-uid-validity when expectedUidValidity does not match", async () => {
    // Guard mechanism is exercised end-to-end (with a real UIDVALIDITY
    // change) in the storeFlags rebuild test. Here we just verify the
    // guard is wired into expungeMessages.
    const mailbox = "ExpungeStale";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox });

    const [uid] = await getUids(mailbox);
    const result = await withImapConnection(creds(), (client) =>
      expungeMessages(client, { mailbox, uids: [uid!], expectedUidValidity: 1 }),
    );

    expect(result).toEqual({ ok: false, reason: "uid-validity-stale" });
    // Message survives
    const remaining = await getUids(mailbox);
    expect(remaining).toHaveLength(1);
  });

  it("removes only specified UIDs, keeps others", async () => {
    const mailbox = "ExpungeMulti";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, headers: { subject: "Gone 1" } });
    await seedMessage(creds(), { mailbox, headers: { subject: "Gone 2" } });
    await seedMessage(creds(), { mailbox, headers: { subject: "Stays" } });

    const allUids = await getUids(mailbox);
    expect(allUids).toHaveLength(3);

    const toDelete = allUids.slice(0, 2);
    await withImapConnection(creds(), (client) =>
      expungeMessages(client, { mailbox, uids: toDelete }),
    );

    const remaining = await getUids(mailbox);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(allUids[2]);
  });

  it("does not expunge other messages flagged as \\Deleted", async () => {
    const mailbox = "ExpungeScoped";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, headers: { subject: "Flagged deleted" } });
    await seedMessage(creds(), { mailbox, headers: { subject: "Target" } });

    const uids = await getUids(mailbox);
    const [flaggedUid, targetUid] = uids;

    // Mark first message as \Deleted via storeFlags (simulating another process)
    await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [flaggedUid!], flags: ["\\Deleted"], operation: "add" }),
    );

    // Expunge only the second message
    await withImapConnection(creds(), (client) =>
      expungeMessages(client, { mailbox, uids: [targetUid!] }),
    );

    // First message must survive despite having \Deleted flag
    const remaining = await getUids(mailbox);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(flaggedUid);
  });
});

describe("appendMessage", () => {
  it("appends with given flags and returns the new UID via UIDPLUS", async () => {
    const mailbox = "AppendBasic";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));

    const raw = Buffer.from(
      [
        "From: sender@localhost",
        "To: commandsuser@localhost",
        "Date: " + new Date().toUTCString(),
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Subject: Appended directly",
        "",
        "Body content for APPEND.",
      ].join("\r\n"),
    );

    const result = await withImapConnection(creds(), (client) =>
      appendMessage(client, { mailbox, raw, flags: ["\\Seen"] }),
    );

    // Stalwart advertises UIDPLUS, so APPENDUID populates uid/uidValidity
    // and the returned uid must match what SEARCH ALL finds in the mailbox.
    expect(result.uid).not.toBeNull();
    expect(result.uidValidity).not.toBeNull();

    const uids = await getUids(mailbox);
    expect(uids).toHaveLength(1);
    expect(result.uid).toBe(uids[0]);
    const flags = await fetchFlags(mailbox, uids[0]!);
    expect(flags.has("\\Seen")).toBe(true);
  });

  it("defaults to no flags when the flags input is omitted", async () => {
    const mailbox = "AppendNoFlags";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));

    const raw = Buffer.from(
      [
        "From: sender@localhost",
        "To: commandsuser@localhost",
        "Date: " + new Date().toUTCString(),
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Subject: Unflagged",
        "",
        "No flags on this one.",
      ].join("\r\n"),
    );

    await withImapConnection(creds(), (client) => appendMessage(client, { mailbox, raw }));

    const uids = await getUids(mailbox);
    const flags = await fetchFlags(mailbox, uids[0]!);
    expect(flags.has("\\Seen")).toBe(false);
  });

  it("throws raw imapflow error (not NonRetriable) when destination mailbox missing", async () => {
    // append.js re-raises server NOs (unlike move/store/expunge which
    // swallow). Pin the error class to verify the contract: missing
    // mailbox is a server NO that surfaces as a raw Error carrying the
    // server response code, not a NonRetriable - callers can inspect it
    // and decide whether to CREATE+retry or surface to the user.
    const raw = Buffer.from(
      "From: s@l\r\nTo: r@l\r\nDate: Mon, 1 Jan 2024 00:00:00 +0000\r\n\r\nx",
    );
    const err = await withImapConnection(creds(), (client) =>
      appendMessage(client, { mailbox: "DoesNotExist", raw }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ImapPrimitiveNonRetriableError);
  });
});
