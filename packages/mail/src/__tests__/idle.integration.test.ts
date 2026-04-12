import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExistsInfo, ExpungeInfo, FlagsInfo, ReconnectedInfo } from "../idle";

import { expungeMessages, storeFlags } from "../commands";
import { withImapConnection } from "../connection";
import { IdleManager } from "../idle";
import { seedMessage, testCredentials } from "./setup";

const creds = () => testCredentials("idleuser");

describe("IdleManager (Stalwart)", () => {
  const managers: IdleManager[] = [];

  afterEach(() => {
    for (const m of managers) m.stop();
    managers.length = 0;
  });

  it("receives EXISTS and EXPUNGE events for a message lifecycle", async () => {
    const mailbox = "IdleEventsTest";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));

    const existsEvents: ExistsInfo[] = [];
    const expungeEvents: ExpungeInfo[] = [];

    const manager = new IdleManager({
      credentials: creds(),
      targetMailbox: mailbox,
      onExists: (info) => existsEvents.push(info),
      onExpunge: (info) => expungeEvents.push(info),
      onReconnected: () => {},
    });
    managers.push(manager);
    await manager.start();

    // Seed a message from a separate connection — the IDLE connection
    // should receive an EXISTS notification from the server.
    await seedMessage(creds(), { mailbox, headers: { subject: "Lifecycle test" } });

    await vi.waitFor(
      () => {
        expect(existsEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000, interval: 100 },
    );

    expect(existsEvents[0]!.path).toBe(mailbox);
    expect(existsEvents[0]!.count).toBeGreaterThan(0);

    // Delete the message from a separate connection — the same IDLE
    // connection should receive an EXPUNGE notification.
    const uid = await withImapConnection(creds(), async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uids = (await client.search({ all: true }, { uid: true })) || [];
        return uids[0]!;
      } finally {
        lock.release();
      }
    });

    await withImapConnection(creds(), (client) =>
      expungeMessages(client, { mailbox, uids: [uid] }),
    );

    await vi.waitFor(
      () => {
        expect(expungeEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000, interval: 100 },
    );

    expect(expungeEvents[0]!.path).toBe(mailbox);
  });

  it("receives FLAGS event when flags change on another client", async () => {
    const mailbox = "IdleFlagsTest";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, headers: { subject: "Flags test" } });

    const uid = await withImapConnection(creds(), async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uids = (await client.search({ all: true }, { uid: true })) || [];
        return uids[0]!;
      } finally {
        lock.release();
      }
    });

    const flagsEvents: FlagsInfo[] = [];

    const manager = new IdleManager({
      credentials: creds(),
      targetMailbox: mailbox,
      onExists: () => {},
      onExpunge: () => {},
      onFlags: (info) => flagsEvents.push(info),
      onReconnected: () => {},
    });
    managers.push(manager);
    await manager.start();

    // Mark the message as \Seen from a separate connection.
    await withImapConnection(creds(), (client) =>
      storeFlags(client, { mailbox, uids: [uid], flags: ["\\Seen"], operation: "add" }),
    );

    await vi.waitFor(
      () => {
        expect(flagsEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000, interval: 100 },
    );

    expect(flagsEvents[0]!.path).toBe(mailbox);
    expect(flagsEvents[0]!.flags.has("\\Seen")).toBe(true);
  });

  it("reconnects after disconnect and detects missed messages", async () => {
    const mailbox = "IdleReconnectTest";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));

    // Seed a message so the mailbox has uidNext > 1 before IdleManager starts.
    await seedMessage(creds(), { mailbox, headers: { subject: "Pre-idle message" } });

    const reconnectedEvents: ReconnectedInfo[] = [];
    const statusChanges: string[] = [];

    const manager = new IdleManager({
      credentials: creds(),
      targetMailbox: mailbox,
      onExists: () => {},
      onExpunge: () => {},
      onReconnected: (info) => reconnectedEvents.push(info),
      onStatusChange: (status) => statusChanges.push(status),
      reconnectionOptions: {
        backoff: { baseDelayMs: 200, jitterMs: 50, maxDelayMs: 1_000 },
      },
    });
    managers.push(manager);
    await manager.start();

    expect(statusChanges).toContain("connected");

    // Seed a message while the connection is about to be dropped.
    // This advances uidNext so the reconnect detects missed messages.
    await seedMessage(creds(), { mailbox, headers: { subject: "Missed message" } });

    // Force-close the underlying client to trigger reconnection.
    // Access the private client field for test purposes.
    const client = (manager as unknown as { client: { close: () => void } }).client;
    client.close();

    await vi.waitFor(
      () => {
        expect(reconnectedEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 15_000, interval: 100 },
    );

    expect(reconnectedEvents[0]!.missedMessages).toBe(true);
    expect(statusChanges).toContain("reconnecting");
    // The last status after reconnect should be "connected" again.
    expect(statusChanges[statusChanges.length - 1]).toBe("connected");
  });

  it("reconnects without missed messages and continues receiving events", async () => {
    const mailbox = "IdleNoMissedTest";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));

    // Seed a message so the mailbox has uidNext > 1.
    await seedMessage(creds(), { mailbox, headers: { subject: "Pre-idle" } });

    const reconnectedEvents: ReconnectedInfo[] = [];
    const existsEvents: ExistsInfo[] = [];

    const manager = new IdleManager({
      credentials: creds(),
      targetMailbox: mailbox,
      onExists: (info) => existsEvents.push(info),
      onExpunge: () => {},
      onReconnected: (info) => reconnectedEvents.push(info),
      reconnectionOptions: {
        backoff: { baseDelayMs: 200, jitterMs: 50, maxDelayMs: 1_000 },
      },
    });
    managers.push(manager);
    await manager.start();

    // Force disconnect WITHOUT seeding a message during the outage.
    // uidNext is unchanged -> missedMessages should be false.
    const client = (manager as unknown as { client: { close: () => void } }).client;
    client.close();

    await vi.waitFor(
      () => {
        expect(reconnectedEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 15_000, interval: 100 },
    );

    expect(reconnectedEvents[0]!.missedMessages).toBe(false);

    // After reconnection, IDLE should still forward events (verifies
    // wireEvents + startIdle re-wiring on the new client).
    await seedMessage(creds(), { mailbox, headers: { subject: "Post-reconnect" } });

    await vi.waitFor(
      () => {
        expect(existsEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000, interval: 100 },
    );

    expect(existsEvents[0]!.path).toBe(mailbox);
  });
});
