import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReconnectionManagerOptions } from "../reconnection";

import { classifyImapError } from "../errors";
import { ReconnectionManager, computeBackoffDelay } from "../reconnection";

// ---------------------------------------------------------------------------
// classifyImapError
// ---------------------------------------------------------------------------

describe("classifyImapError", () => {
  it("classifies auth errors via authenticationFailed property", () => {
    const err = Object.assign(new Error("Invalid credentials"), {
      authenticationFailed: true,
    });
    const result = classifyImapError(err);
    expect(result.category).toBe("auth");
    expect(result.message).toBe("Invalid credentials");
  });

  // Representative codes from each source. All codes take the same path
  // (TRANSIENT_CODES.has) - these document the two sources without testing
  // Set membership exhaustively.
  it.each([
    "ECONNRESET", // Node.js socket - connection dropped by peer
    "ETIMEDOUT", // Node.js socket - network timeout
    "NoConnection", // imapflow - connection unavailable
  ])("classifies %s as transient", (code) => {
    const err = Object.assign(new Error(`Network error: ${code}`), { code });
    expect(classifyImapError(err).category).toBe("transient");
  });

  it("classifies ETHROTTLE as rate-limit", () => {
    const err = Object.assign(new Error("Throttled"), { code: "ETHROTTLE" });
    expect(classifyImapError(err).category).toBe("rate-limit");
  });

  it("classifies 'too many connections' message as rate-limit", () => {
    const err = new Error("NO Too many connections from your IP");
    expect(classifyImapError(err).category).toBe("rate-limit");
  });

  it("classifies unknown errors as protocol", () => {
    const err = new Error("BAD Unknown command");
    expect(classifyImapError(err).category).toBe("protocol");
  });

  it("classifies non-object error as protocol", () => {
    expect(classifyImapError("raw string error").category).toBe("protocol");
  });

  it("treats undefined as transient (close event with no error)", () => {
    // imapflow's close event fires with no argument (this.emit('close')),
    // so the callback receives undefined. This is the most common
    // production trigger for reconnection (server BYE, restart).
    expect(classifyImapError(undefined).category).toBe("transient");
  });

  it("prioritizes auth over transient and preserves error code", () => {
    const err = Object.assign(new Error("Auth timeout"), {
      authenticationFailed: true,
      code: "ETIMEDOUT",
    });
    const result = classifyImapError(err);
    expect(result.category).toBe("auth");
    expect(result.code).toBe("ETIMEDOUT");
  });
});

// ---------------------------------------------------------------------------
// computeBackoffDelay
// ---------------------------------------------------------------------------

describe("computeBackoffDelay", () => {
  it("returns base delay + jitter for attempt 0", () => {
    // With default config: base=2000, jitter up to 1000
    const delay = computeBackoffDelay(0);
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(3000);
  });

  it("returns base * multiplier + jitter for attempt 1", () => {
    // 2000 * 1.5 = 3000, + up to 1000 jitter
    const delay = computeBackoffDelay(1);
    expect(delay).toBeGreaterThanOrEqual(3000);
    expect(delay).toBeLessThanOrEqual(4000);
  });

  it("caps at maxDelay + jitter for high attempts", () => {
    // Default max is 30000, jitter up to 1000
    const delay = computeBackoffDelay(20);
    expect(delay).toBeGreaterThanOrEqual(30_000);
    expect(delay).toBeLessThanOrEqual(31_000);
  });

  it("caps exponent at 10 - attempt 10 and 15 produce same base", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    // Use a high maxDelay so the clamp doesn't mask the exponent cap.
    // Without this, both attempts exceed 30k and produce the same result
    // regardless of whether the cap exists.
    const config = { maxDelayMs: 500_000, jitterMs: 0 };
    const delay10 = computeBackoffDelay(10, config);
    const delay15 = computeBackoffDelay(15, config);
    expect(delay10).toBe(delay15);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// ReconnectionManager
// ---------------------------------------------------------------------------

describe("ReconnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockImapClient() {
    return { close: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never;
  }

  function createManager(overrides?: Partial<ReconnectionManagerOptions>) {
    const defaults: ReconnectionManagerOptions = {
      connect: vi.fn().mockResolvedValue(mockImapClient()),
      onReconnected: vi.fn().mockResolvedValue(undefined),
      onAuthFailure: vi.fn(),
      onAuthDisabled: vi.fn(),
      onProtocolError: vi.fn(),
      // Use zero jitter for deterministic timer assertions
      backoff: { jitterMs: 0 },
      ...overrides,
    };
    return { manager: new ReconnectionManager(defaults), opts: defaults };
  }

  // -------------------------------------------------------------------------
  // Basic reconnection
  // -------------------------------------------------------------------------

  it("reconnects on transient error and fires onReconnected", async () => {
    const { manager, opts } = createManager();

    manager.handleDisconnect(Object.assign(new Error("reset"), { code: "ECONNRESET" }));

    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.connect).toHaveBeenCalledTimes(1);
    expect(opts.onReconnected).toHaveBeenCalledTimes(1);
  });

  it("reconnects on clean close (undefined error - server BYE / restart)", async () => {
    const { manager, opts } = createManager();

    manager.handleDisconnect(undefined);

    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.connect).toHaveBeenCalledTimes(1);
    expect(opts.onReconnected).toHaveBeenCalledTimes(1);
  });

  it("resets attempt counter after successful reconnect", async () => {
    const { manager, opts } = createManager();
    const connectFn = opts.connect as ReturnType<typeof vi.fn>;

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ETIMEDOUT" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // Second disconnect - should use attempt 0 delay again (reset happened)
    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ETIMEDOUT" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Auth failure + circuit breaker
  // -------------------------------------------------------------------------

  it("fires onAuthFailure and still schedules reconnect on auth error", async () => {
    const { manager, opts } = createManager();

    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));

    // Immediate notification
    expect(opts.onAuthFailure).toHaveBeenCalledTimes(1);
    expect((opts.onAuthFailure as ReturnType<typeof vi.fn>).mock.calls[0]![0].category).toBe(
      "auth",
    );

    // Still schedules reconnect (user might fix credentials)
    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.connect).toHaveBeenCalledTimes(1);
  });

  it("disables after auth failures exceed 3-day threshold", async () => {
    const { manager, opts } = createManager({
      authDisableThresholdMs: 500,
      backoff: { baseDelayMs: 100, jitterMs: 0, maxDelayMs: 200 },
      connect: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("bad creds"), { authenticationFailed: true })),
    });

    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));
    expect(opts.onAuthFailure).toHaveBeenCalledTimes(1);
    expect(opts.onAuthDisabled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(opts.onAuthDisabled).toHaveBeenCalled();
  });

  it("resets auth failure window after successful recovery", async () => {
    const { manager, opts } = createManager({
      authDisableThresholdMs: 5_000,
    });

    // Auth failure at t=0 starts tracking
    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));
    await vi.advanceTimersByTimeAsync(2000); // reconnect succeeds, clears tracking

    // Advance past the threshold from the original auth failure
    await vi.advanceTimersByTimeAsync(6_000); // now at t=8000

    // New auth failure - if window wasn't cleared, 8000 > 5000 -> disable.
    // Since reconnect succeeded, this starts a fresh window.
    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));
    expect(opts.onAuthDisabled).not.toHaveBeenCalled();

    manager.stop();
  });

  it("transient connect() failures do not reset auth failure window", async () => {
    const connectFn = vi
      .fn()
      // First attempts: network blips (transient)
      .mockRejectedValueOnce(Object.assign(new Error("net"), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error("net"), { code: "ECONNRESET" }))
      // Then: server reachable but creds still bad (auth)
      .mockRejectedValue(Object.assign(new Error("bad creds"), { authenticationFailed: true }));

    const { manager, opts } = createManager({
      connect: connectFn,
      authDisableThresholdMs: 500,
      backoff: { baseDelayMs: 100, jitterMs: 0, maxDelayMs: 200 },
    });

    // Auth failure at t=0 starts tracking window
    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));

    // Reconnect attempts fail with transient, then auth. The transient
    // failures should NOT reset the auth window - a network blip during
    // reconnect says nothing about whether credentials are valid. Once
    // auth errors resume, the clock keeps running from t=0.
    await vi.advanceTimersByTimeAsync(1_000);

    // Auth window accumulated through transient failures -> threshold reached
    expect(opts.onAuthDisabled).toHaveBeenCalled();
  });

  it("surfaces auth failure from connect() through onAuthFailure", async () => {
    const connectFn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("token expired"), { authenticationFailed: true }),
      )
      .mockResolvedValue(mockImapClient());
    const { manager, opts } = createManager({ connect: connectFn });

    manager.handleDisconnect(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(opts.onAuthFailure).toHaveBeenCalledTimes(1);
    expect((opts.onAuthFailure as ReturnType<typeof vi.fn>).mock.calls[0]![0].category).toBe(
      "auth",
    );

    manager.stop();
  });

  it("auth disable permanently stops the manager", async () => {
    const { manager, opts } = createManager({
      authDisableThresholdMs: 100,
      backoff: { baseDelayMs: 200, jitterMs: 0, maxDelayMs: 200 },
      connect: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("bad creds"), { authenticationFailed: true })),
    });

    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));
    await vi.advanceTimersByTimeAsync(300);

    expect(opts.onAuthDisabled).toHaveBeenCalled();

    // Manager is now stopped - new disconnect should be no-op
    manager.handleDisconnect(Object.assign(new Error("new error"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opts.connect).toHaveBeenCalledTimes(1);
  });

  it("auth disable stops the manager even if onAuthDisabled throws", async () => {
    const { manager, opts } = createManager({
      authDisableThresholdMs: 100,
      backoff: { baseDelayMs: 200, jitterMs: 0, maxDelayMs: 200 },
      connect: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("bad creds"), { authenticationFailed: true })),
      onAuthDisabled: () => {
        throw new Error("callback crashed");
      },
    });

    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));
    await vi.advanceTimersByTimeAsync(300);

    // Manager should be stopped regardless of callback failure
    manager.handleDisconnect(Object.assign(new Error("new"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opts.connect).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Protocol + rate-limit errors
  // -------------------------------------------------------------------------

  it("fires onProtocolError with no retry", async () => {
    const { manager, opts } = createManager();

    manager.handleDisconnect(new Error("BAD Unknown command"));

    expect(opts.onProtocolError).toHaveBeenCalledTimes(1);
    expect((opts.onProtocolError as ReturnType<typeof vi.fn>).mock.calls[0]![0].category).toBe(
      "protocol",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(opts.connect).not.toHaveBeenCalled();
  });

  it("treats connect() failure with no error code as protocol (no retry)", async () => {
    const connectFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("TLS handshake failed"))
      .mockResolvedValue(mockImapClient());
    const onProtocolError = vi.fn();
    const { manager } = createManager({ connect: connectFn, onProtocolError });

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it("uses higher backoff ceiling for auth errors than transient", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const connectFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("bad creds"), { authenticationFailed: true }));
    const { manager } = createManager({
      connect: connectFn,
      backoff: { baseDelayMs: 100, maxDelayMs: 200, jitterMs: 0 },
      authMaxDelayMs: 1000,
    });

    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));

    // With transient ceiling (200ms), attempt 5+ would cap at 200ms.
    // With auth ceiling (1000ms), attempt 5 = min(1000, 100 * 1.5^5) = 759ms.
    // Advance past transient ceiling but before auth delay to prove the
    // higher ceiling is in effect.
    await vi.advanceTimersByTimeAsync(100); // attempt 0 fires
    // attempt 1: 150ms
    await vi.advanceTimersByTimeAsync(150);
    // attempt 2: 225ms - already exceeds transient ceiling (200ms)
    // If auth ceiling weren't applied, this would be clamped to 200ms
    await vi.advanceTimersByTimeAsync(225);
    expect(connectFn).toHaveBeenCalledTimes(3);

    // attempt 3: 100 * 1.5^3 = 337ms (would be 200ms without auth ceiling)
    await vi.advanceTimersByTimeAsync(200);
    expect(connectFn).toHaveBeenCalledTimes(3); // hasn't fired yet at 200ms
    await vi.advanceTimersByTimeAsync(137);
    expect(connectFn).toHaveBeenCalledTimes(4); // fires at 337ms

    manager.stop();
    vi.restoreAllMocks();
  });

  it("uses longer backoff for rate-limit errors and escalates across attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const connectFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Throttled"), { code: "ETHROTTLE" }));
    const { manager } = createManager({ connect: connectFn });

    manager.handleDisconnect(Object.assign(new Error("Throttled"), { code: "ETHROTTLE" }));

    // At 2000ms (normal transient delay), connect should NOT have been called
    vi.advanceTimersByTime(2000);
    expect(connectFn).not.toHaveBeenCalled();

    // Attempt 0: base * 5 = 10000 (5x multiplier vs transient)
    await vi.advanceTimersByTimeAsync(8000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // Attempt 1: base * 5 * 1.5 = 15000 (escalates with attempt counter)
    await vi.advanceTimersByTimeAsync(15000);
    expect(connectFn).toHaveBeenCalledTimes(2);

    manager.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Backoff escalation
  // -------------------------------------------------------------------------

  it("increments backoff delay across failed reconnect attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const connectFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("still down"), { code: "ECONNREFUSED" }));
    const { manager } = createManager({ connect: connectFn });

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ECONNREFUSED" }));

    // Attempt 0: 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // Attempt 1: 3000ms (2000 * 1.5)
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectFn).toHaveBeenCalledTimes(2);

    // Attempt 2: 4500ms (2000 * 1.5^2)
    await vi.advanceTimersByTimeAsync(4500);
    expect(connectFn).toHaveBeenCalledTimes(3);

    manager.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // stop() / reset() / debouncing
  // -------------------------------------------------------------------------

  it("stop() cancels pending reconnection and blocks further handleDisconnect", async () => {
    const { manager, opts } = createManager();

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ETIMEDOUT" }));
    manager.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(opts.connect).not.toHaveBeenCalled();

    // Subsequent handleDisconnect is also a no-op
    manager.handleDisconnect(Object.assign(new Error("t2"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opts.connect).not.toHaveBeenCalled();
  });

  it("stop() during in-flight connect() closes orphaned client", async () => {
    let resolveConnect!: (client: never) => void;
    const connectFn = vi.fn().mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const { manager, opts } = createManager({ connect: connectFn });

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    manager.stop();

    const orphanedClient = mockImapClient();
    resolveConnect(orphanedClient);
    await vi.advanceTimersByTimeAsync(0);

    expect((orphanedClient as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(opts.onReconnected).not.toHaveBeenCalled();
  });

  it("stop() during onReconnected prevents further scheduling", async () => {
    const connectFn = vi.fn().mockResolvedValue(mockImapClient());
    const { manager } = createManager({
      connect: connectFn,
      onReconnected: vi.fn().mockImplementation(async () => {
        manager.stop();
        throw new Error("callback failed after stop");
      }),
    });

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(connectFn).toHaveBeenCalledTimes(1);
  });

  it("reset() after stop() allows a fresh handleDisconnect cycle", async () => {
    const { manager, opts } = createManager();

    manager.stop();
    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ETIMEDOUT" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(opts.connect).not.toHaveBeenCalled();

    manager.reset();
    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.connect).toHaveBeenCalledTimes(1);
    expect(opts.onReconnected).toHaveBeenCalledTimes(1);
  });

  it("reset() during in-flight reconnect invalidates stale attempt and closes client", async () => {
    let connectResolve: ((client: never) => void) | null = null;
    const connectFn = vi.fn().mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          connectResolve = resolve;
        }),
    );
    const onReconnected = vi.fn().mockResolvedValue(undefined);

    const { manager } = createManager({
      connect: connectFn,
      onReconnected,
    });

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);
    const staleResolve = connectResolve!;

    manager.reset();

    const staleClient = mockImapClient();
    staleResolve(staleClient);
    await vi.advanceTimersByTimeAsync(0);

    expect(onReconnected).not.toHaveBeenCalled();
    expect((staleClient as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
  });

  it("reset() clears auth failure tracking for a fresh window", async () => {
    const { manager, opts } = createManager({
      authDisableThresholdMs: 5_000,
      backoff: { baseDelayMs: 100, jitterMs: 0, maxDelayMs: 200 },
    });

    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));
    await vi.advanceTimersByTimeAsync(100);

    manager.reset();
    await vi.advanceTimersByTimeAsync(6_000);

    // New auth failure - should start a fresh window, not from pre-reset
    manager.handleDisconnect(Object.assign(new Error("bad creds"), { authenticationFailed: true }));
    expect(opts.onAuthDisabled).not.toHaveBeenCalled();

    manager.stop();
  });

  it("reset() clears prolonged outage state and restores normal retry ceiling", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const connectFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    const onProlongedOutage = vi.fn();
    const { manager } = createManager({
      connect: connectFn,
      onProlongedOutage,
      prolongedOutageThresholdMs: 50,
      backoff: { baseDelayMs: 100, maxDelayMs: 100, jitterMs: 0 },
      prolongedOutageMaxDelayMs: 500,
    });

    manager.handleDisconnect(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    // First retry at t=100 crosses 50ms threshold -> prolonged outage fires
    await vi.advanceTimersByTimeAsync(100);
    expect(onProlongedOutage).toHaveBeenCalledTimes(1);

    manager.reset();

    // After reset: normal ceiling (100ms) should apply, not prolonged (500ms)
    manager.handleDisconnect(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    await vi.advanceTimersByTimeAsync(100);
    const callsAfterReset = connectFn.mock.calls.length;
    expect(callsAfterReset).toBeGreaterThan(1);

    // Prolonged outage should re-notify after crossing threshold again
    await vi.advanceTimersByTimeAsync(100);
    expect(onProlongedOutage).toHaveBeenCalledTimes(2);

    manager.stop();
    vi.restoreAllMocks();
  });

  it("ignores handleDisconnect while connect() is in-flight", async () => {
    let resolveConnect!: (client: never) => void;
    const connectFn = vi.fn().mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const { manager, opts } = createManager({ connect: connectFn });

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // Another disconnect while connect() is in-flight - debounced
    manager.handleDisconnect(Object.assign(new Error("t2"), { code: "ECONNRESET" }));

    resolveConnect(mockImapClient());
    await vi.advanceTimersByTimeAsync(0);

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(opts.onReconnected).toHaveBeenCalledTimes(1);
  });

  it("deduplicates rapid handleDisconnect calls", async () => {
    const { manager, opts } = createManager();

    manager.handleDisconnect(Object.assign(new Error("t1"), { code: "ECONNRESET" }));
    manager.handleDisconnect(Object.assign(new Error("t2"), { code: "ECONNRESET" }));
    manager.handleDisconnect(Object.assign(new Error("t3"), { code: "ECONNRESET" }));

    await vi.advanceTimersByTimeAsync(2000);
    expect(opts.connect).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Prolonged outage
  // -------------------------------------------------------------------------

  it("fires onProlongedOutage once after threshold and raises retry ceiling", async () => {
    // Timeline with baseDelayMs=100, maxDelayMs=100, threshold=50:
    //   t=0:   handleDisconnect -> firstTransientFailureAt=0, 0<50 -> schedule(delay=100)
    //   t=100: retry fails -> handleDisconnect -> 100>=50 -> CALLBACK FIRES
    //          schedule with prolongedOutageMaxDelayMs=500: delay=min(500, 150)=150
    //   t=250: retry fails -> callback already fired (once only)
    //          Without ceiling change, delay would be min(100, 150)=100 -> retry at t=200
    //          With ceiling change, delay is min(500, 150)=150 -> retry at t=250
    vi.spyOn(Math, "random").mockReturnValue(0);
    const connectFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    const onProlongedOutage = vi.fn();
    const { manager } = createManager({
      connect: connectFn,
      onProlongedOutage,
      prolongedOutageThresholdMs: 50,
      backoff: { baseDelayMs: 100, maxDelayMs: 100, jitterMs: 0 },
      prolongedOutageMaxDelayMs: 500,
    });

    manager.handleDisconnect(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    expect(onProlongedOutage).not.toHaveBeenCalled();

    // First retry at t=100 crosses the 50ms threshold
    await vi.advanceTimersByTimeAsync(100);
    expect(onProlongedOutage).toHaveBeenCalledTimes(1);
    const callsAfterFirst = connectFn.mock.calls.length;

    // Verify raised ceiling: old ceiling (100ms) passes without a retry
    await vi.advanceTimersByTimeAsync(100);
    expect(connectFn.mock.calls.length).toBe(callsAfterFirst);

    // But new delay (150ms from t=100) does fire at t=250
    await vi.advanceTimersByTimeAsync(50);
    expect(connectFn.mock.calls.length).toBe(callsAfterFirst + 1);

    // Callback still only fired once
    expect(onProlongedOutage).toHaveBeenCalledTimes(1);

    manager.stop();
    vi.restoreAllMocks();
  });

  it("clears prolonged outage state on recovery, re-notifies on next outage", async () => {
    // Timeline:
    //   t=0:   handleDisconnect -> schedule(delay=100)
    //   t=100: 1st connect fails -> 100>=50 -> callback fires (1st)
    //          schedule(delay=150 with new ceiling)
    //   t=250: 2nd connect succeeds -> state cleared
    //   t=250: new handleDisconnect -> firstTransientFailureAt=250, schedule(delay=100)
    //   t=350: 3rd connect fails -> 350-250=100>=50 -> callback fires (2nd)
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onProlongedOutage = vi.fn();
    const connectFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("down"), { code: "ECONNREFUSED" }))
      .mockResolvedValueOnce(mockImapClient())
      .mockRejectedValue(Object.assign(new Error("down again"), { code: "ECONNREFUSED" }));

    const { manager } = createManager({
      connect: connectFn,
      onProlongedOutage,
      prolongedOutageThresholdMs: 50,
      backoff: { baseDelayMs: 100, maxDelayMs: 100, jitterMs: 0 },
    });

    // First outage - callback fires at t=100
    manager.handleDisconnect(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(onProlongedOutage).toHaveBeenCalledTimes(1);

    // Recovery at t=250 clears state
    await vi.advanceTimersByTimeAsync(150);
    expect(connectFn).toHaveBeenCalledTimes(2);

    // Second outage - callback fires again since recovery cleared the state
    manager.handleDisconnect(Object.assign(new Error("down again"), { code: "ECONNREFUSED" }));
    await vi.advanceTimersByTimeAsync(200);
    expect(onProlongedOutage).toHaveBeenCalledTimes(2);

    manager.stop();
    vi.restoreAllMocks();
  });

  it("rate-limit errors do not trigger prolonged outage notification", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onProlongedOutage = vi.fn();
    const connectFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Throttled"), { code: "ETHROTTLE" }));
    const { manager } = createManager({
      connect: connectFn,
      onProlongedOutage,
      prolongedOutageThresholdMs: 200,
      backoff: { baseDelayMs: 100, jitterMs: 0 },
    });

    manager.handleDisconnect(Object.assign(new Error("Throttled"), { code: "ETHROTTLE" }));

    // Advance well past threshold - prolonged outage should never fire
    // because rate-limit has its own backoff and doesn't track transient state
    await vi.advanceTimersByTimeAsync(5000);
    expect(onProlongedOutage).not.toHaveBeenCalled();
    expect(connectFn.mock.calls.length).toBeGreaterThan(0);

    manager.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // onReconnected failure handling
  // -------------------------------------------------------------------------

  it("retries after onReconnected failure and closes the failed client", async () => {
    const clients: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const connectFn = vi.fn().mockImplementation(() => {
      const client = mockImapClient();
      clients.push(client as { close: ReturnType<typeof vi.fn> });
      return Promise.resolve(client);
    });
    let callCount = 0;
    const { manager } = createManager({
      connect: connectFn,
      onReconnected: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw Object.assign(new Error("IDLE setup failed"), { code: "ECONNRESET" });
        }
      }),
    });

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ETIMEDOUT" }));

    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(clients[0]!.close).toHaveBeenCalledTimes(1);

    // Attempts NOT reset -> attempt 1 = 3000ms
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(clients[1]!.close).not.toHaveBeenCalled();
  });

  it("treats onReconnected auth-like failure as transient (does not abort)", async () => {
    const connectFn = vi.fn().mockResolvedValue(mockImapClient());
    const onAuthFailure = vi.fn();
    let callCount = 0;
    const { manager } = createManager({
      connect: connectFn,
      onAuthFailure,
      onReconnected: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Simulates: connection authenticated, but SELECT INBOX returns
          // auth rejection (OAuth token expired between connect and command)
          throw Object.assign(new Error("NO Access denied"), {
            authenticationFailed: true,
          });
        }
      }),
    });

    manager.handleDisconnect(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    // Callback failure should NOT trigger auth handling - connect itself
    // succeeded, so credentials were valid at connect time.
    expect(onAuthFailure).not.toHaveBeenCalled();

    // Should retry (transient), not abort (protocol)
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectFn).toHaveBeenCalledTimes(2);
  });

  it("retries when onReconnected throws a non-IMAP error", async () => {
    const connectFn = vi.fn().mockResolvedValue(mockImapClient());
    let callCount = 0;
    const onProtocolError = vi.fn();
    const { manager } = createManager({
      connect: connectFn,
      onProtocolError,
      onReconnected: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Plain Error - would classify as "protocol" (no retry) if sent
          // through handleDisconnect. Callback errors bypass classification.
          throw new Error("DB connection failed");
        }
      }),
    });

    manager.handleDisconnect(Object.assign(new Error("t"), { code: "ETIMEDOUT" }));

    await vi.advanceTimersByTimeAsync(2000);
    expect(connectFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(onProtocolError).not.toHaveBeenCalled();
  });
});
