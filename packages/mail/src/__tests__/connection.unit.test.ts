import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImapCredentials } from "../connection";

// ---------------------------------------------------------------------------
// Mock imapflow - ImapConnectionCache calls createImapClient internally,
// which constructs ImapFlow. We intercept at the constructor level.
// ---------------------------------------------------------------------------

type MockClient = {
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  /** Simulate imapflow's error + close sequence (socket error, ETIMEOUT, etc.) */
  _emitError: (err: Error) => void;
  /** Simulate imapflow's close event (server BYE, graceful disconnect). */
  _emitClose: () => void;
};

const { createMockClient, pendingClients, listeners } = vi.hoisted(() => {
  const listeners = new Map<object, { error?: (err: Error) => void; close?: () => void }>();
  const pendingClients: object[] = [];

  function createMockClient() {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const entry = listeners.get(client) ?? {};
        if (event === "error") entry.error = cb as (err: Error) => void;
        if (event === "close") entry.close = cb;
        listeners.set(client, entry);
      }),
      _emitError(err: Error) {
        listeners.get(this)?.error?.(err);
      },
      _emitClose() {
        listeners.get(this)?.close?.();
      },
    };
    return client;
  }

  return { createMockClient, pendingClients, listeners };
});

vi.mock("imapflow", () => ({
  // Must use `function` (not arrow) so it can be called with `new`
  ImapFlow: vi.fn(function () {
    return pendingClients.shift() ?? createMockClient();
  }),
}));

const { ImapConnectionCache } = await import("../connection");

const TEST_CREDS: ImapCredentials = {
  host: "imap.example.com",
  port: 993,
  secure: true,
  user: "test@example.com",
  pass: "password",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ImapConnectionCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    pendingClients.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Connection reuse
  // -------------------------------------------------------------------------

  it("reuses connections for the same email account and isolates different email accounts", async () => {
    const cache = new ImapConnectionCache();
    let clientA: unknown;
    let clientA2: unknown;
    let clientB: unknown;

    await cache.execute("acc1", TEST_CREDS, async (client) => {
      clientA = client;
    });
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      clientA2 = client;
    });
    await cache.execute("acc2", TEST_CREDS, async (client) => {
      clientB = client;
    });

    expect(clientA).toBe(clientA2);
    expect(clientA).not.toBe(clientB);
    cache.closeAll();
  });

  // -------------------------------------------------------------------------
  // Inactivity timer
  // -------------------------------------------------------------------------

  it("evicts connection after inactivity timeout and reconnects on next use", async () => {
    const cache = new ImapConnectionCache({ inactivityTimeoutMs: 5_000 });
    let captured: MockClient | undefined;

    await cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client as unknown as MockClient;
    });

    expect(captured!.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(captured!.close).toHaveBeenCalledTimes(1);

    // User comes back after idle - should get a fresh connection
    let afterEviction: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      afterEviction = client;
    });
    expect(afterEviction).not.toBe(captured);
    cache.closeAll();
  });

  it("resets inactivity timer on each execute call", async () => {
    const cache = new ImapConnectionCache({ inactivityTimeoutMs: 5_000 });
    let captured: MockClient | undefined;

    await cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client as unknown as MockClient;
    });

    // Advance 4s (not enough to trigger), then execute again
    await vi.advanceTimersByTimeAsync(4_000);
    expect(captured!.close).not.toHaveBeenCalled();

    await cache.execute("acc1", TEST_CREDS, async () => {});

    // Advance another 4s - 8s total from first call, but only 4s from reset
    await vi.advanceTimersByTimeAsync(4_000);
    expect(captured!.close).not.toHaveBeenCalled();

    // 1 more second completes the reset timeout
    await vi.advanceTimersByTimeAsync(1_000);
    expect(captured!.close).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Concurrent dedup
  // -------------------------------------------------------------------------

  it("deduplicates concurrent connection attempts for the same email account", async () => {
    const mockClient = createMockClient() as MockClient;
    let resolveConnect!: () => void;
    mockClient.connect.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveConnect = resolve;
      }),
    );
    pendingClients.push(mockClient);

    const cache = new ImapConnectionCache();
    let clientA: unknown;
    let clientB: unknown;

    const promiseA = cache.execute("acc1", TEST_CREDS, async (client) => {
      clientA = client;
    });
    const promiseB = cache.execute("acc1", TEST_CREDS, async (client) => {
      clientB = client;
    });

    resolveConnect();
    await Promise.all([promiseA, promiseB]);

    expect(clientA).toBe(clientB);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    cache.closeAll();
  });

  // -------------------------------------------------------------------------
  // Reference counting
  // -------------------------------------------------------------------------

  it("does not set inactivity timer while operations are in-flight", async () => {
    const cache = new ImapConnectionCache({ inactivityTimeoutMs: 1_000 });
    let captured: MockClient | undefined;

    let resolveOp!: () => void;
    const longOp = cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client as unknown as MockClient;
      await new Promise<void>((resolve) => {
        resolveOp = resolve;
      });
    });

    // Let connect resolve but not the operation
    await vi.advanceTimersByTimeAsync(0);

    // Timer period passes while operation is in-flight
    await vi.advanceTimersByTimeAsync(2_000);
    expect(captured!.close).not.toHaveBeenCalled();

    // Finish the operation - now timer should start
    resolveOp();
    await longOp;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(captured!.close).toHaveBeenCalledTimes(1);
  });

  it("waits for all concurrent operations (including failures) before setting timer", async () => {
    const cache = new ImapConnectionCache({ inactivityTimeoutMs: 1_000 });
    let captured: MockClient | undefined;

    let resolveOpA!: () => void;
    let resolveOpB!: () => void;

    const opA = cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client as unknown as MockClient;
      await new Promise<void>((r) => {
        resolveOpA = r;
      });
      throw new Error("command failed");
    });

    // Let connect complete before starting opB
    await vi.advanceTimersByTimeAsync(0);

    const opB = cache.execute("acc1", TEST_CREDS, async () => {
      await new Promise<void>((r) => {
        resolveOpB = r;
      });
    });

    // opA throws - refcount drops from 2 to 1, no timer yet
    resolveOpA();
    await expect(opA).rejects.toThrow("command failed");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(captured!.close).not.toHaveBeenCalled();

    // opB finishes - refcount drops to 0, timer starts
    resolveOpB();
    await opB;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(captured!.close).toHaveBeenCalledTimes(1);
  });

  it("sets inactivity timer on replacement connection when all operations finish", async () => {
    const cache = new ImapConnectionCache({ inactivityTimeoutMs: 1_000 });

    const clientA = createMockClient() as MockClient;
    pendingClients.push(clientA);

    let resolveOpA!: () => void;
    const opA = cache.execute("acc1", TEST_CREDS, async () => {
      // Connection dies mid-operation (server restart, network drop)
      clientA._emitClose();
      await new Promise<void>((r) => {
        resolveOpA = r;
      });
      return "synced";
    });

    // Let connect + fn start
    await vi.advanceTimersByTimeAsync(0);

    // Concurrent caller creates a replacement connection
    const clientB = createMockClient() as MockClient;
    pendingClients.push(clientB);

    const opB = cache.execute("acc1", TEST_CREDS, async () => "marked");

    // Let B's connect complete
    await vi.advanceTimersByTimeAsync(0);

    // opB finishes first - refcount drops but is not zero (opA still in-flight)
    expect(await opB).toBe("marked");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clientB.close).not.toHaveBeenCalled(); // timer must NOT fire yet

    // opA finishes - refcount reaches zero, timer starts on clientB
    resolveOpA();
    expect(await opA).toBe("synced");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(clientB.close).toHaveBeenCalledTimes(1); // timer fires on replacement
  });

  // -------------------------------------------------------------------------
  // Close-listener eviction
  // -------------------------------------------------------------------------

  it("evicts connection when close event fires (server BYE / network drop)", async () => {
    const cache = new ImapConnectionCache();
    let captured: MockClient | undefined;

    await cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client as unknown as MockClient;
    });

    // Simulate server disconnect
    captured!._emitClose();

    // Next call should create a new connection
    let secondClient: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      secondClient = client;
    });
    expect(secondClient).not.toBe(captured);
    cache.closeAll();
  });

  it("does not evict on command-level errors", async () => {
    const cache = new ImapConnectionCache();
    let captured: unknown;

    await cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client;
    });

    await expect(
      cache.execute("acc1", TEST_CREDS, async () => {
        throw new Error("UID not found");
      }),
    ).rejects.toThrow("UID not found");

    // Same connection should still be cached
    let afterError: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      afterError = client;
    });
    expect(afterError).toBe(captured);
    cache.closeAll();
  });

  it("error event on idle connection does not crash, close event still evicts", async () => {
    const cache = new ImapConnectionCache();
    let captured: MockClient | undefined;

    await cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client as unknown as MockClient;
    });

    // imapflow emits error before close on socket failures. The error
    // listener should absorb it (no uncaught exception), and the close
    // listener should evict the connection.
    captured!._emitError(new Error("ETIMEOUT"));
    captured!._emitClose();

    // Next call should create a fresh connection
    let secondClient: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      secondClient = client;
    });
    expect(secondClient).not.toBe(captured);
    cache.closeAll();
  });

  it("close event during successful fn does not corrupt state", async () => {
    const cache = new ImapConnectionCache({ inactivityTimeoutMs: 1_000 });
    let captured: MockClient | undefined;

    // Server sends BYE mid-operation, but buffered data lets fn complete
    const result = await cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client as unknown as MockClient;
      captured._emitClose();
      return "fetched";
    });

    expect(result).toBe("fetched");

    // Next call should get a fresh connection, not the dead one
    let secondClient: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      secondClient = client;
    });
    expect(secondClient).not.toBe(captured);
    cache.closeAll();
  });

  it("handles concurrent fn error and connection close", async () => {
    const cache = new ImapConnectionCache();
    let captured: MockClient | undefined;

    // fn throws AND the connection closes simultaneously
    await expect(
      cache.execute("acc1", TEST_CREDS, async (client) => {
        captured = client as unknown as MockClient;
        // Connection breaks mid-operation
        captured._emitClose();
        // Then the command also throws
        throw new Error("socket hangup");
      }),
    ).rejects.toThrow("socket hangup");

    // Connection was evicted by close listener, close was called
    expect(captured!.close).toHaveBeenCalled();

    // Next call creates a fresh connection (not the evicted one)
    let secondClient: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      secondClient = client;
    });
    expect(secondClient).not.toBe(captured);
    cache.closeAll();
  });

  it("stale close event does not evict a newer connection", async () => {
    const cache = new ImapConnectionCache();

    const clientA = createMockClient() as MockClient;
    pendingClients.push(clientA);

    await cache.execute("acc1", TEST_CREDS, async () => {});

    // Connection A breaks, evicted
    clientA._emitClose();

    // New connection B is created
    const clientB = createMockClient() as MockClient;
    pendingClients.push(clientB);
    let captured: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client;
    });
    expect(captured).toBe(clientB);

    // Stale close event from client A fires again - should NOT evict B
    clientA._emitClose();

    let afterStale: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      afterStale = client;
    });
    expect(afterStale).toBe(clientB);
    cache.closeAll();
  });

  it("close(id) during in-flight connect discards stale connection", async () => {
    const cache = new ImapConnectionCache();

    const slowClient = createMockClient() as MockClient;
    let resolveConnect!: () => void;
    slowClient.connect.mockReturnValue(
      new Promise<void>((r) => {
        resolveConnect = r;
      }),
    );
    pendingClients.push(slowClient);

    // Start a slow connect (high-latency server)
    const stalePromise = cache.execute("acc1", TEST_CREDS, async () => {});

    // Credential rotation: close while connect is in-flight
    cache.close("acc1");

    // New execute should start a fresh connect, not dedup onto the stale one
    const freshClient = createMockClient() as MockClient;
    pendingClients.push(freshClient);

    let captured: unknown;
    const freshPromise = cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client;
    });

    await freshPromise;
    expect(captured).toBe(freshClient);

    // Stale connect resolves - should be discarded, not overwrite freshClient
    resolveConnect();
    await expect(stalePromise).rejects.toThrow("cache closed during connect");
    expect(slowClient.close).toHaveBeenCalledTimes(1);

    // freshClient is still the active connection (not overwritten by stale)
    let afterStale: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      afterStale = client;
    });
    expect(afterStale).toBe(freshClient);
    cache.closeAll();
  });

  it("close(id) evicts the connection and next execute reconnects", async () => {
    const cache = new ImapConnectionCache();
    let clientA: MockClient | undefined;

    await cache.execute("acc1", TEST_CREDS, async (client) => {
      clientA = client as unknown as MockClient;
    });

    cache.close("acc1");
    expect(clientA!.close).toHaveBeenCalledTimes(1);

    // Next execute creates a fresh connection (e.g., after credential rotation)
    let clientB: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      clientB = client;
    });
    expect(clientB).not.toBe(clientA);
    cache.closeAll();
  });

  // -------------------------------------------------------------------------
  // closeAll
  // -------------------------------------------------------------------------

  it("discards in-flight connect when closeAll is called", async () => {
    const mockClient = createMockClient() as MockClient;
    let resolveConnect!: () => void;
    mockClient.connect.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveConnect = resolve;
      }),
    );
    pendingClients.push(mockClient);

    const cache = new ImapConnectionCache();
    const promise = cache.execute("acc1", TEST_CREDS, async () => {});

    // closeAll while connect is in-flight
    cache.closeAll();

    // Let connect resolve - the connection should be discarded, not resurrected
    resolveConnect();

    await expect(promise).rejects.toThrow("cache closed during connect");
    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  it("closes all cached connections across accounts", async () => {
    const cache = new ImapConnectionCache();
    const clients: MockClient[] = [];

    await cache.execute("acc1", TEST_CREDS, async (client) => {
      clients.push(client as unknown as MockClient);
    });
    await cache.execute("acc2", TEST_CREDS, async (client) => {
      clients.push(client as unknown as MockClient);
    });

    cache.closeAll();

    expect(clients[0]!.close).toHaveBeenCalledTimes(1);
    expect(clients[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("does not break in-flight operations when closeAll is called", async () => {
    const cache = new ImapConnectionCache();
    let captured: MockClient | undefined;
    let resolveOp!: () => void;

    const op = cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client as unknown as MockClient;
      await new Promise<void>((r) => {
        resolveOp = r;
      });
      return "result";
    });

    // Let connect complete
    await vi.advanceTimersByTimeAsync(0);

    // closeAll while fn is running - evicts the connection
    cache.closeAll();
    expect(captured!.close).toHaveBeenCalled();

    // In-flight operation still completes normally
    resolveOp();
    await expect(op).resolves.toBe("result");
  });

  // -------------------------------------------------------------------------
  // Connect failure
  // -------------------------------------------------------------------------

  it("propagates connect failure and allows retry", async () => {
    const failingClient = createMockClient() as MockClient;
    failingClient.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    pendingClients.push(failingClient);

    const cache = new ImapConnectionCache();

    await expect(cache.execute("acc1", TEST_CREDS, async () => {})).rejects.toThrow("ECONNREFUSED");

    // Retry should create a fresh connection
    const goodClient = createMockClient() as MockClient;
    pendingClients.push(goodClient);

    let captured: unknown;
    await cache.execute("acc1", TEST_CREDS, async (client) => {
      captured = client;
    });
    expect(captured).toBe(goodClient);
    cache.closeAll();
  });

  it("concurrent callers all fail when connect fails", async () => {
    const failingClient = createMockClient() as MockClient;
    let rejectConnect!: (err: Error) => void;
    failingClient.connect.mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectConnect = reject;
      }),
    );
    pendingClients.push(failingClient);

    const cache = new ImapConnectionCache();

    const promiseA = cache.execute("acc1", TEST_CREDS, async () => {});
    const promiseB = cache.execute("acc1", TEST_CREDS, async () => {});

    rejectConnect(new Error("ECONNREFUSED"));

    // Await both concurrently to prevent unhandled rejection on the second
    await Promise.all([
      expect(promiseA).rejects.toThrow("ECONNREFUSED"),
      expect(promiseB).rejects.toThrow("ECONNREFUSED"),
    ]);
  });
});
