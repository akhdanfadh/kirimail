import type { ImapFlow } from "imapflow";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createImapClient } from "../connection";
import { ReconnectionManager } from "../reconnection";
import { testCredentials } from "./setup";

const creds = () => testCredentials("reconnectuser");

describe("ReconnectionManager (Stalwart)", () => {
  // Track resources for guaranteed cleanup on test failure (e.g., vi.waitFor
  // timeout). Prevents leaked IMAP connections between tests.
  const managers: ReconnectionManager[] = [];
  const clients: ImapFlow[] = [];

  afterEach(() => {
    for (const m of managers) m.stop();
    for (const c of clients) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    managers.length = 0;
    clients.length = 0;
  });

  it("recovers from connection close and fires onReconnected", async () => {
    let reconnectedClient: ImapFlow | null = null;

    const manager = new ReconnectionManager({
      connect: async () => {
        const client = createImapClient(creds());
        await client.connect();
        clients.push(client);
        return client;
      },
      onReconnected: async (client) => {
        reconnectedClient = client;
      },
      backoff: { baseDelayMs: 100, jitterMs: 50, maxDelayMs: 500 },
    });
    managers.push(manager);

    manager.handleDisconnect(Object.assign(new Error("connection closed"), { code: "ECONNRESET" }));

    await vi.waitFor(
      () => {
        expect(reconnectedClient).not.toBeNull();
      },
      { timeout: 10_000, interval: 100 },
    );

    const mailboxes = await reconnectedClient!.list();
    expect(mailboxes.length).toBeGreaterThan(0);
  });

  it("surfaces auth failure from real IMAP server", async () => {
    const authFailures: Array<{ category: string; message: string }> = [];
    const badCreds = { ...creds(), pass: "wrongpassword" };

    const manager = new ReconnectionManager({
      connect: async () => {
        const client = createImapClient(badCreds);
        await client.connect();
        return client;
      },
      onReconnected: async () => {},
      onAuthFailure: (error) => {
        authFailures.push(error);
      },
      backoff: { baseDelayMs: 100, jitterMs: 50, maxDelayMs: 500 },
    });
    managers.push(manager);

    manager.handleDisconnect(Object.assign(new Error("simulated drop"), { code: "ECONNRESET" }));

    await vi.waitFor(
      () => {
        expect(authFailures.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000, interval: 100 },
    );

    expect(authFailures[0]!.category).toBe("auth");
  });
});
