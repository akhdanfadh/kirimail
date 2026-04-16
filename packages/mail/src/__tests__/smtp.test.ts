import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SmtpCredentials } from "../smtp";

// ---------------------------------------------------------------------------
// Mock nodemailer - SmtpTransportCache calls createTransport internally.
// We intercept it to return mock transport objects.
// ---------------------------------------------------------------------------

type MockTransport = {
  sendMail: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

const { createMockTransport, pendingTransports } = vi.hoisted(() => {
  const pendingTransports: MockTransport[] = [];

  function createMockTransport(): MockTransport {
    return {
      sendMail: vi.fn().mockResolvedValue({
        accepted: ["recipient@example.com"],
        rejected: [],
        messageId: "<test@example.com>",
        response: "250 OK",
        envelope: { from: "sender@example.com", to: ["recipient@example.com"] },
      }),
      close: vi.fn(),
      on: vi.fn(),
    };
  }

  return { createMockTransport, pendingTransports };
});

vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => pendingTransports.shift() ?? createMockTransport()),
}));

// Mock stripBcc - the real implementation uses mailsplit streams that hang
// under vi.useFakeTimers(). BCC stripping is tested in compose.test.ts;
// here we verify send() calls it and passes the result to sendMail.
const mockStripBcc = vi.hoisted(() => vi.fn((raw: Buffer) => Promise.resolve(raw)));
vi.mock("../compose", () => ({ stripBcc: mockStripBcc }));

const { SmtpTransportCache, appendToSentFolder } = await import("../smtp");

const TEST_CREDS: SmtpCredentials = {
  host: "smtp.example.com",
  port: 465,
  security: "tls",
  auth: { user: "test@example.com", pass: "password" },
};

const TEST_RAW = Buffer.from("Subject: test\r\n\r\nHello");
const TEST_ENVELOPE = { from: "sender@example.com", to: ["recipient@example.com"] };

// ---------------------------------------------------------------------------
// SmtpTransportCache
// ---------------------------------------------------------------------------

describe("SmtpTransportCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pendingTransports.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Transport reuse
  // -------------------------------------------------------------------------

  it("reuses transport for the same email account and isolates different accounts", async () => {
    const transportA = createMockTransport();
    const transportB = createMockTransport();
    pendingTransports.push(transportA, transportB);

    const cache = new SmtpTransportCache();

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    await cache.send("acc2", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    expect(transportA.sendMail).toHaveBeenCalledTimes(2);
    expect(transportB.sendMail).toHaveBeenCalledTimes(1);
    cache.closeAll();
  });

  it("auto-evicts transport on credential mismatch", async () => {
    const transportA = createMockTransport();
    const transportB = createMockTransport();
    pendingTransports.push(transportA, transportB);

    const cache = new SmtpTransportCache();

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Same account, rotated password - should evict old transport
    const rotatedCreds: SmtpCredentials = {
      ...TEST_CREDS,
      auth: { user: "test@example.com", pass: "new-password" },
    };
    await cache.send("acc1", rotatedCreds, TEST_RAW, TEST_ENVELOPE);

    expect(transportA.close).toHaveBeenCalledTimes(1);
    expect(transportA.sendMail).toHaveBeenCalledTimes(1);
    expect(transportB.sendMail).toHaveBeenCalledTimes(1);
    cache.closeAll();
  });

  it("handles credential change during in-flight send", async () => {
    const cache = new SmtpTransportCache({ inactivityTimeoutMs: 1_000 });
    const transportA = createMockTransport();
    const transportB = createMockTransport();
    pendingTransports.push(transportA, transportB);

    let resolveSendA!: (v: unknown) => void;
    transportA.sendMail.mockReturnValue(
      new Promise((resolve) => {
        resolveSendA = resolve;
      }),
    );

    // Call 1: starts with original creds, in-flight on transport A
    const sendA = cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    await vi.advanceTimersByTimeAsync(0);

    // Call 2: arrives with rotated creds - evicts A, creates B
    const rotatedCreds: SmtpCredentials = {
      ...TEST_CREDS,
      auth: { user: "test@example.com", pass: "new-password" },
    };
    const sendB = cache.send("acc1", rotatedCreds, TEST_RAW, TEST_ENVELOPE);
    await sendB;

    // Transport A was evicted (closed), B handled call 2
    expect(transportA.close).toHaveBeenCalledTimes(1);
    expect(transportB.sendMail).toHaveBeenCalledTimes(1);

    // Call 1 completes - inflight decrements correctly, timer not reset
    // until all operations finish
    resolveSendA({
      accepted: ["r@e.com"],
      rejected: [],
      messageId: "<t@e.com>",
      response: "250 OK",
    });
    await sendA;

    // Timer starts only after both calls finish, on transport B
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transportB.close).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Inactivity timer
  // -------------------------------------------------------------------------

  it("evicts transport after inactivity timeout and creates fresh on next use", async () => {
    const cache = new SmtpTransportCache({ inactivityTimeoutMs: 5_000 });
    const transportA = createMockTransport();
    pendingTransports.push(transportA);

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    expect(transportA.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(transportA.close).toHaveBeenCalledTimes(1);

    // Next send creates a fresh transport
    const transportB = createMockTransport();
    pendingTransports.push(transportB);
    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    expect(transportB.sendMail).toHaveBeenCalledTimes(1);
    cache.closeAll();
  });

  it("resets inactivity timer on each send", async () => {
    const cache = new SmtpTransportCache({ inactivityTimeoutMs: 5_000 });
    const transport = createMockTransport();
    pendingTransports.push(transport);

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Advance 4s (not enough to trigger), then send again
    await vi.advanceTimersByTimeAsync(4_000);
    expect(transport.close).not.toHaveBeenCalled();

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Another 4s - 8s total from first send, but only 4s from reset
    await vi.advanceTimersByTimeAsync(4_000);
    expect(transport.close).not.toHaveBeenCalled();

    // 1 more second completes the reset timeout
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Reference counting
  // -------------------------------------------------------------------------

  it("does not set inactivity timer while sends are in-flight", async () => {
    const cache = new SmtpTransportCache({ inactivityTimeoutMs: 1_000 });
    const transport = createMockTransport();
    pendingTransports.push(transport);

    let resolveSend!: (v: unknown) => void;
    transport.sendMail.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const longSend = cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Timer period passes while send is in-flight
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transport.close).not.toHaveBeenCalled();

    // Finish the send - now timer should start
    resolveSend({
      accepted: ["r@e.com"],
      rejected: [],
      messageId: "<t@e.com>",
      response: "250 OK",
    });
    await longSend;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("waits for all concurrent sends (including failures) before setting timer", async () => {
    const cache = new SmtpTransportCache({ inactivityTimeoutMs: 1_000 });
    const transport = createMockTransport();
    pendingTransports.push(transport);

    let resolveSendA!: (v: unknown) => void;
    let resolveSendB!: () => void;

    // First send will succeed
    transport.sendMail.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSendA = resolve;
      }),
    );

    const sendA = cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Let send A start
    await vi.advanceTimersByTimeAsync(0);

    // Second send will reject
    transport.sendMail.mockReturnValueOnce(
      new Promise((_, reject) => {
        resolveSendB = () => reject(new Error("rejected"));
      }),
    );

    const sendB = cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // sendB throws - refcount drops from 2 to 1, no timer yet
    resolveSendB();
    await expect(sendB).rejects.toThrow("rejected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transport.close).not.toHaveBeenCalled();

    // sendA finishes - refcount drops to 0, timer starts
    resolveSendA({
      accepted: ["r@e.com"],
      rejected: [],
      messageId: "<t@e.com>",
      response: "250 OK",
    });
    await sendA;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // close / closeAll
  // -------------------------------------------------------------------------

  it("close(id) evicts transport, next send reconnects", async () => {
    const cache = new SmtpTransportCache();
    const transportA = createMockTransport();
    pendingTransports.push(transportA);

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    cache.close("acc1");
    expect(transportA.close).toHaveBeenCalledTimes(1);

    // Next send creates a fresh transport
    const transportB = createMockTransport();
    pendingTransports.push(transportB);
    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    expect(transportB.sendMail).toHaveBeenCalledTimes(1);
    cache.closeAll();
  });

  it("closeAll closes all transports, cache reusable after", async () => {
    const cache = new SmtpTransportCache();
    const transports: MockTransport[] = [];

    const tA = createMockTransport();
    const tB = createMockTransport();
    pendingTransports.push(tA, tB);

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    await cache.send("acc2", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    transports.push(tA, tB);

    cache.closeAll();
    expect(transports[0]!.close).toHaveBeenCalledTimes(1);
    expect(transports[1]!.close).toHaveBeenCalledTimes(1);

    // Cache is reusable after closeAll
    const fresh = createMockTransport();
    pendingTransports.push(fresh);
    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    expect(fresh.sendMail).toHaveBeenCalledTimes(1);
    cache.closeAll();
  });

  it("closeAll does not break in-flight sends", async () => {
    const cache = new SmtpTransportCache();
    const transport = createMockTransport();
    pendingTransports.push(transport);

    let resolveSend!: (v: unknown) => void;
    transport.sendMail.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const sendPromise = cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Let send start
    await vi.advanceTimersByTimeAsync(0);

    // closeAll while send is running - evicts transport
    cache.closeAll();
    expect(transport.close).toHaveBeenCalled();

    // In-flight send still completes normally
    resolveSend({
      accepted: ["r@e.com"],
      rejected: [],
      messageId: "<t@e.com>",
      response: "250 OK",
    });
    const result = await sendPromise;
    expect(result.accepted).toEqual(["r@e.com"]);
  });

  it("close(id) does not break in-flight sends", async () => {
    const cache = new SmtpTransportCache();
    const transport = createMockTransport();
    pendingTransports.push(transport);

    let resolveSend!: (v: unknown) => void;
    transport.sendMail.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const sendPromise = cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    await vi.advanceTimersByTimeAsync(0);

    cache.close("acc1");
    expect(transport.close).toHaveBeenCalled();

    resolveSend({
      accepted: ["r@e.com"],
      rejected: [],
      messageId: "<t@e.com>",
      response: "250 OK",
    });
    const result = await sendPromise;
    expect(result.accepted).toEqual(["r@e.com"]);
  });

  it("close and closeAll are idempotent", async () => {
    const cache = new SmtpTransportCache();
    const transport = createMockTransport();
    pendingTransports.push(transport);

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Double close(id) - second is a no-op
    cache.close("acc1");
    cache.close("acc1");
    expect(transport.close).toHaveBeenCalledTimes(1);

    // closeAll after close - no-op
    cache.closeAll();
    expect(transport.close).toHaveBeenCalledTimes(1);

    // closeAll twice - second is a no-op
    const transport2 = createMockTransport();
    pendingTransports.push(transport2);
    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    cache.closeAll();
    cache.closeAll();
    expect(transport2.close).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Transport error event
  // -------------------------------------------------------------------------

  it("evicts transport on error event", async () => {
    const cache = new SmtpTransportCache();
    let errorHandler!: () => void;
    const transport = createMockTransport();
    transport.on.mockImplementation((event: string, cb: () => void) => {
      if (event === "error") errorHandler = cb;
    });
    pendingTransports.push(transport);

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    errorHandler();
    expect(transport.close).toHaveBeenCalledTimes(1);

    // Next send creates fresh transport
    const fresh = createMockTransport();
    pendingTransports.push(fresh);
    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    expect(fresh.sendMail).toHaveBeenCalledTimes(1);
    cache.closeAll();
  });

  it("stale transport error does not evict its replacement", async () => {
    const cache = new SmtpTransportCache();
    let errorHandlerA!: () => void;
    const transportA = createMockTransport();
    transportA.on.mockImplementation((event: string, cb: () => void) => {
      if (event === "error") errorHandlerA = cb;
    });
    const transportB = createMockTransport();
    pendingTransports.push(transportA, transportB);

    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Credential rotation replaces A with B
    const rotated: SmtpCredentials = {
      ...TEST_CREDS,
      auth: { user: "test@example.com", pass: "new" },
    };
    await cache.send("acc1", rotated, TEST_RAW, TEST_ENVELOPE);

    // A's delayed error fires - must NOT evict B
    errorHandlerA();
    expect(transportB.close).not.toHaveBeenCalled();

    // B is still cached and usable
    await cache.send("acc1", rotated, TEST_RAW, TEST_ENVELOPE);
    expect(transportB.sendMail).toHaveBeenCalledTimes(2);
    cache.closeAll();
  });

  // -------------------------------------------------------------------------
  // sendMail integration
  // -------------------------------------------------------------------------

  it("calls stripBcc before SMTP transmission", async () => {
    const cache = new SmtpTransportCache();
    const transport = createMockTransport();
    pendingTransports.push(transport);

    const raw = Buffer.from("Subject: test\r\nBcc: hidden@b.com\r\n\r\nBody");
    const strippedRaw = Buffer.from("Subject: test\r\n\r\nBody");
    mockStripBcc.mockResolvedValueOnce(strippedRaw);

    await cache.send("acc1", TEST_CREDS, raw, TEST_ENVELOPE);

    // stripBcc was called with the original raw bytes
    expect(mockStripBcc).toHaveBeenCalledWith(raw);
    // sendMail received the stripped result, not the original
    expect(transport.sendMail).toHaveBeenCalledWith({
      raw: strippedRaw,
      envelope: expect.any(Object),
    });
    cache.closeAll();
  });

  it("maps sendMail response to SmtpSendResult", async () => {
    const cache = new SmtpTransportCache();
    const transport = createMockTransport();
    transport.sendMail.mockResolvedValue({
      accepted: ["a@b.com"],
      rejected: ["bad@fail.com"],
      messageId: "<unique@host.com>",
      response: "250 2.0.0 OK",
      envelope: { from: "sender@x.com", to: ["a@b.com"] },
      // Extra fields from nodemailer that we don't include in SmtpSendResult
      envelopeTime: 50,
      messageTime: 100,
      messageSize: 500,
    });
    pendingTransports.push(transport);

    const result = await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    expect(result).toEqual({
      accepted: ["a@b.com"],
      rejected: ["bad@fail.com"],
      messageId: "<unique@host.com>",
      response: "250 2.0.0 OK",
    });
    cache.closeAll();
  });

  it("propagates sendMail errors to caller", async () => {
    const cache = new SmtpTransportCache();
    const transport = createMockTransport();
    transport.sendMail.mockRejectedValue(new Error("EAUTH: Invalid login"));
    pendingTransports.push(transport);

    await expect(cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE)).rejects.toThrow(
      "EAUTH: Invalid login",
    );
    cache.closeAll();
  });

  it("does not evict transport on send-level errors", async () => {
    const cache = new SmtpTransportCache();
    const transport = createMockTransport();
    pendingTransports.push(transport);

    // First send succeeds
    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);

    // Second send fails
    transport.sendMail.mockRejectedValueOnce(new Error("550 Mailbox not found"));
    await expect(cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE)).rejects.toThrow(
      "550 Mailbox not found",
    );

    // Transport still cached - third send reuses it
    transport.sendMail.mockResolvedValueOnce({
      accepted: ["r@e.com"],
      rejected: [],
      messageId: "<t@e.com>",
      response: "250 OK",
    });
    await cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE);
    expect(transport.sendMail).toHaveBeenCalledTimes(3);
    cache.closeAll();
  });

  it("propagates stripBcc errors without creating a transport", async () => {
    mockStripBcc.mockRejectedValueOnce(new Error("parse failed"));
    const cache = new SmtpTransportCache();

    await expect(cache.send("acc1", TEST_CREDS, TEST_RAW, TEST_ENVELOPE)).rejects.toThrow(
      "parse failed",
    );
    // stripBcc throws before getOrCreate - no transport created or leaked
    cache.closeAll(); // no-op, nothing to close
  });
});

// ---------------------------------------------------------------------------
// appendToSentFolder
// ---------------------------------------------------------------------------

describe("appendToSentFolder", () => {
  const imapCreds = {
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "test@example.com",
    pass: "password",
  };

  it("calls client.append with correct path, raw, and \\Seen flag", async () => {
    const mockAppend = vi.fn().mockResolvedValue(undefined);
    const mockCache = {
      execute: vi.fn(
        async (
          _id: string,
          _creds: unknown,
          fn: (client: { append: typeof mockAppend }) => Promise<void>,
        ) => fn({ append: mockAppend }),
      ),
    };

    const raw = Buffer.from("Subject: test\r\nBcc: hidden@x.com\r\n\r\nBody");
    await appendToSentFolder(mockCache as never, "acc1", imapCreds, raw, "Sent");

    expect(mockCache.execute).toHaveBeenCalledWith("acc1", imapCreds, expect.any(Function));
    expect(mockAppend).toHaveBeenCalledWith("Sent", raw, ["\\Seen"]);
  });

  it("swallows APPEND errors and logs warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockCache = {
      execute: vi.fn().mockRejectedValue(new Error("IMAP connection lost")),
    };

    await expect(
      appendToSentFolder(mockCache as never, "acc1", imapCreds, TEST_RAW, "INBOX.Sent"),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      '[sent] APPEND to "INBOX.Sent" failed for acc1:',
      "IMAP connection lost",
    );
    warnSpy.mockRestore();
  });
});
