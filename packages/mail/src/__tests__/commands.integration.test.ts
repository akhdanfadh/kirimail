import { describe, expect, it } from "vitest";

import { expungeMessages, moveMessages, storeFlags } from "../commands";
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
  it("adds \\Seen to an unseen message and returns true", async () => {
    const mailbox = "StoreFlagsAddSeen";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox });

    const [uid] = await getUids(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [uid!], flags: ["\\Seen"], operation: "add" }),
    );

    expect(result).toBe(true);
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

  it("operates on multiple UIDs", async () => {
    const mailbox = "StoreFlagsMultiUid";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, headers: { subject: "Multi 1" } });
    await seedMessage(creds(), { mailbox, headers: { subject: "Multi 2" } });
    await seedMessage(creds(), { mailbox, headers: { subject: "Multi 3" } });

    const uids = await getUids(mailbox);
    expect(uids).toHaveLength(3);

    await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids, flags: ["\\Seen"], operation: "add" }),
    );

    for (const uid of uids) {
      const flags = await fetchFlags(mailbox, uid!);
      expect(flags.has("\\Seen")).toBe(true);
    }
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

  it("returns false for empty UID array", async () => {
    const mailbox = "StoreFlagsEmptyUids";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox });

    const result = await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [], flags: ["\\Seen"], operation: "add" }),
    );

    expect(result).toBe(false);
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

    expect(result).toBe(true);
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

    expect(result).toBe(false);

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

    expect(result.moved).toBe(true);
    expect(result.uidMap.size).toBe(1);
    expect(result.uidMap.has(sourceUid!)).toBe(true);

    // Verify actual mailbox state matches the reported result
    const sourceUids = await getUids(source);
    const destUids = await getUids(dest);
    expect(sourceUids).toHaveLength(0);
    expect(destUids).toHaveLength(1);
    expect(result.uidMap.get(sourceUid!)).toBe(destUids[0]);
  });

  it("moves multiple messages", async () => {
    const source = "MoveMultiSource";
    const dest = "MoveMultiDest";
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate(source);
      await client.mailboxCreate(dest);
    });
    await seedMessage(creds(), { mailbox: source, headers: { subject: "Batch 1" } });
    await seedMessage(creds(), { mailbox: source, headers: { subject: "Batch 2" } });
    await seedMessage(creds(), { mailbox: source, headers: { subject: "Batch 3" } });

    const uids = await getUids(source);
    expect(uids).toHaveLength(3);

    const result = await withImapConnection(creds(), (client) =>
      moveMessages(client, { mailbox: source, destination: dest, uids }),
    );

    expect(result.moved).toBe(true);
    expect(result.uidMap.size).toBe(3);
    const sourceUids = await getUids(source);
    const destUids = await getUids(dest);
    expect(sourceUids).toHaveLength(0);
    expect(destUids).toHaveLength(3);
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

    expect(result.moved).toBe(true);
    expect(result.uidMap.size).toBe(2);
    const sourceUids = await getUids(source);
    const destUids = await getUids(dest);
    expect(sourceUids).toHaveLength(0);
    expect(destUids).toHaveLength(2);
  });

  it("reports moved:false when destination does not exist", async () => {
    const source = "MoveNoDestSource";
    await withImapConnection(creds(), (client) => client.mailboxCreate(source));
    await seedMessage(creds(), { mailbox: source });

    const [uid] = await getUids(source);

    const result = await withImapConnection(creds(), (client) =>
      moveMessages(client, { mailbox: source, destination: "NoSuchMailbox", uids: [uid!] }),
    );

    expect(result.moved).toBe(false);

    // Source message still exists (server rejected the move)
    const remaining = await getUids(source);
    expect(remaining).toHaveLength(1);
  });

  it("reports moved:false for empty UID array", async () => {
    const source = "MoveEmptyUids";
    const dest = "MoveEmptyUidsDest";
    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate(source);
      await client.mailboxCreate(dest);
    });
    await seedMessage(creds(), { mailbox: source });

    const result = await withImapConnection(creds(), (client) =>
      moveMessages(client, { mailbox: source, destination: dest, uids: [] }),
    );

    expect(result.moved).toBe(false);

    // Source message untouched
    const remaining = await getUids(source);
    expect(remaining).toHaveLength(1);
  });

  it("reports moved:true with empty uidMap for non-existent source UID", async () => {
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
    expect(result.moved).toBe(true);
    expect(result.uidMap.size).toBe(0);

    // Original message still in source, nothing in dest
    const sourceUids = await getUids(source);
    const destUids = await getUids(dest);
    expect(sourceUids).toHaveLength(1);
    expect(destUids).toHaveLength(0);
  });
});

describe("expungeMessages", () => {
  it("permanently removes a message and returns true", async () => {
    const mailbox = "ExpungeSingle";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox });

    const [uid] = await getUids(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      expungeMessages(client, { mailbox, uids: [uid!] }),
    );

    expect(result).toBe(true);
    const remaining = await getUids(mailbox);
    expect(remaining).toHaveLength(0);
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
