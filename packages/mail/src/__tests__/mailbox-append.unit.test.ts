import type { ImapFlow } from "imapflow";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImapConnectionCache, ImapCredentials } from "../connection";

import { ImapPrimitiveNonRetriableError } from "../commands";
import {
  type AppendToMailboxInput,
  type AppendToMailboxResult,
  type AppendToSentFolderInput,
  appendToMailbox,
  appendToSentFolder,
} from "../mailbox-append";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const imapCreds: ImapCredentials = {
  host: "imap.example.com",
  port: 993,
  secure: true,
  user: "test@example.com",
  pass: "password",
};

const RAW = Buffer.from(
  "Subject: test\r\nMessage-ID: <abc@example.com>\r\nBcc: hidden@x.com\r\n\r\nBody",
);
const MAILBOX = "Sent";
const MESSAGE_ID = "<abc@example.com>";

/**
 * Build a minimal imapflow client. The append-to-mailbox path does:
 * getMailboxLock -> (short-circuit if exists=0) -> search(since) ->
 * fetch(envelope) -> maybe appendMessage.
 */
function makeClient(opts: {
  existingCount: number;
  candidateUids?: number[];
  /** Simulate imapflow's false return on server-side failure (Promise<number[] | false>). */
  searchReturnsFalse?: boolean;
  envelopes?: Array<{ uid: number; messageId: string }>;
}) {
  const status = vi.fn().mockResolvedValue({ path: "mailbox", messages: opts.existingCount });
  const lockRelease = vi.fn();
  const getMailboxLock = vi.fn().mockResolvedValue({ release: lockRelease });
  const search = opts.searchReturnsFalse
    ? vi.fn().mockResolvedValue(false)
    : vi.fn().mockResolvedValue(opts.candidateUids ?? []);
  const envelopes = opts.envelopes ?? [];
  const fetch = vi.fn((..._args: unknown[]) =>
    (async function* () {
      for (const env of envelopes) {
        yield { uid: env.uid, envelope: { messageId: env.messageId } };
      }
    })(),
  );
  const append = vi.fn().mockResolvedValue({ uid: 1, uidValidity: 1 });
  const client = {
    mailbox: { exists: opts.existingCount, uidValidity: 1 },
    status,
    getMailboxLock,
    search,
    fetch,
    append,
    usable: true,
  } as unknown as ImapFlow;
  return { client, status, getMailboxLock, lockRelease, search, fetch, append };
}

/** Cache stub that runs `fn` with the given client. */
function makeCache(opts: { client: ImapFlow }): {
  cache: ImapConnectionCache;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(
    async (_id: string, _creds: ImapCredentials, fn: (c: ImapFlow) => Promise<unknown>) =>
      fn(opts.client),
  );
  return { cache: { execute } as unknown as ImapConnectionCache, execute };
}

/** Build an {@link AppendToMailboxInput} with overrides. */
function mailboxInput(
  cache: ImapConnectionCache,
  overrides: Partial<Pick<AppendToMailboxInput, "mailboxPath" | "flags" | "messageId">> = {},
): AppendToMailboxInput {
  return {
    imapCache: cache,
    emailAccountId: "acc1",
    imapCreds,
    raw: RAW,
    mailboxPath: overrides.mailboxPath ?? MAILBOX,
    flags: overrides.flags ?? ["\\Seen"],
    messageId: overrides.messageId ?? MESSAGE_ID,
  };
}

// ---------------------------------------------------------------------------
// appendToMailbox - core behavior
// ---------------------------------------------------------------------------

describe("appendToMailbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips lock and APPENDs directly when STATUS reports empty mailbox", async () => {
    // STATUS avoids a SELECT for the empty cold-start case - no lock round-trip.
    const { client, status, getMailboxLock, lockRelease, search, append } = makeClient({
      existingCount: 0,
    });
    const { cache } = makeCache({ client });

    const result = await appendToMailbox(mailboxInput(cache));

    expect(status).toHaveBeenCalledWith(MAILBOX, { messages: true });
    expect(getMailboxLock).not.toHaveBeenCalled();
    expect(lockRelease).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
    const [path, body, flags] = append.mock.calls[0]!;
    expect(path).toBe(MAILBOX);
    expect(body).toBe(RAW);
    expect(flags).toEqual(["\\Seen"]);
    // deduped: false - we performed the APPEND; uid comes from mock return value.
    expect(result).toEqual<AppendToMailboxResult>({
      ok: true,
      deduped: false,
      uid: 1,
      uidValidity: 1,
    });
  });

  it("probes then APPENDs when the Message-ID is absent (non-empty mailbox)", async () => {
    const { client, append } = makeClient({
      existingCount: 2,
      candidateUids: [10, 11],
      envelopes: [
        { uid: 10, messageId: "<other-a@example.com>" },
        { uid: 11, messageId: "<other-b@example.com>" },
      ],
    });
    const { cache } = makeCache({ client });

    const result = await appendToMailbox(mailboxInput(cache));

    expect(append).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, deduped: false });
  });

  it("returns dedup result with uid when the Message-ID is already present", async () => {
    const { client, append } = makeClient({
      existingCount: 1,
      candidateUids: [42],
      envelopes: [{ uid: 42, messageId: MESSAGE_ID }],
    });
    const { cache } = makeCache({ client });

    const result = await appendToMailbox(mailboxInput(cache));

    expect(append).not.toHaveBeenCalled();
    // uid comes from the FETCH scan - no follow-up SEARCH needed by the handler.
    expect(result).toEqual<AppendToMailboxResult>({
      ok: true,
      deduped: true,
      uid: 42,
      uidValidity: 1,
    });
  });

  it("acquires the mailbox lock read-only (probe must not block writers)", async () => {
    const { client, getMailboxLock } = makeClient({ existingCount: 1, candidateUids: [] });
    const { cache } = makeCache({ client });

    await appendToMailbox(mailboxInput(cache));

    expect(getMailboxLock).toHaveBeenCalledWith(
      MAILBOX,
      expect.objectContaining({ readOnly: true }),
    );
  });

  it("SEARCH uses {since} - date-based probe works regardless of server FTS", async () => {
    const { client, search } = makeClient({ existingCount: 1, candidateUids: [] });
    const { cache } = makeCache({ client });

    await appendToMailbox(mailboxInput(cache));

    expect(search).toHaveBeenCalledOnce();
    const [criteria, opts] = search.mock.calls[0]!;
    expect(criteria).toHaveProperty("since");
    expect(opts).toEqual({ uid: true });
  });

  it("passes caller-supplied flags to appendMessage", async () => {
    const { client, append } = makeClient({ existingCount: 0 });
    const { cache } = makeCache({ client });

    await appendToMailbox(mailboxInput(cache, { flags: ["\\Draft"] }));

    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]![2]).toEqual(["\\Draft"]);
  });

  it("dedup matches case-insensitively on the domain portion", async () => {
    const { client, append } = makeClient({
      existingCount: 1,
      candidateUids: [9],
      envelopes: [{ uid: 9, messageId: "<abc@example.com>" }],
    });
    const { cache } = makeCache({ client });

    // Mixed-case domain in caller id; server ENVELOPE uses lowercase.
    await appendToMailbox(mailboxInput(cache, { messageId: "<abc@Example.COM>" }));

    expect(append).not.toHaveBeenCalled();
  });

  it("dedup matches when the server returns an unbracketed envelope Message-ID", async () => {
    const { client, append } = makeClient({
      existingCount: 1,
      candidateUids: [15],
      // RFC 3501 says ENVELOPE message-id includes brackets, but some
      // middleware (MTAs, anti-spam rewriters) strips them.
      envelopes: [{ uid: 15, messageId: "abc@example.com" }],
    });
    const { cache } = makeCache({ client });

    await appendToMailbox(mailboxInput(cache));

    expect(append).not.toHaveBeenCalled();
  });

  it("dedup preserves local-part case (legally distinct Message-IDs)", async () => {
    const { client, append } = makeClient({
      existingCount: 1,
      candidateUids: [12],
      // Different local-part case = different Message-IDs per RFC 5322.
      envelopes: [{ uid: 12, messageId: "<ABC@example.com>" }],
    });
    const { cache } = makeCache({ client });

    await appendToMailbox(mailboxInput(cache, { messageId: "<abc@example.com>" }));

    expect(append).toHaveBeenCalledOnce();
  });

  it("throws ImapPrimitiveNonRetriableError on malformed messageId (dead-letters immediately)", async () => {
    // assertMessageId throws plain Error, which the queue treats as retriable.
    // appendToMailbox must wrap it so the job dead-letters without burning retries.
    const { client } = makeClient({ existingCount: 0 });
    const { cache, execute } = makeCache({ client });

    await expect(
      appendToMailbox(mailboxInput(cache, { messageId: "bare@example.com" })),
    ).rejects.toBeInstanceOf(ImapPrimitiveNonRetriableError);

    expect(execute).not.toHaveBeenCalled();
  });

  it("throws ImapPrimitiveNonRetriableError when SEARCH returns false (fail-closed - avoid blind APPEND)", async () => {
    // imapflow's search() returns false (not undefined) on server-side failure:
    // Promise<number[] | false>. This is a non-retriable condition - retrying
    // the same job won't fix a broken SEARCH response.
    const { client } = makeClient({ existingCount: 1, searchReturnsFalse: true });
    const { cache } = makeCache({ client });

    await expect(appendToMailbox(mailboxInput(cache))).rejects.toBeInstanceOf(
      ImapPrimitiveNonRetriableError,
    );
  });

  it("throws ImapPrimitiveNonRetriableError when the mailbox lock leaves client.mailbox unset (fail-closed)", async () => {
    // existingCount must be non-zero so STATUS doesn't short-circuit before the lock.
    const { client } = makeClient({ existingCount: 1, candidateUids: [] });
    (client as unknown as { mailbox: undefined }).mailbox = undefined;
    const { cache } = makeCache({ client });

    await expect(appendToMailbox(mailboxInput(cache))).rejects.toBeInstanceOf(
      ImapPrimitiveNonRetriableError,
    );
  });

  it("dedup returns true after iterating past non-matching envelopes (target last)", async () => {
    // Exercises the for-await early-exit path: the loop must walk past two
    // non-matches before hitting return true on the third. The dedup-hit
    // test with a single candidate would pass even if early-exit were broken.
    const { client, append } = makeClient({
      existingCount: 3,
      candidateUids: [1, 2, 3],
      envelopes: [
        { uid: 1, messageId: "<noise-a@example.com>" },
        { uid: 2, messageId: "<noise-b@example.com>" },
        { uid: 3, messageId: MESSAGE_ID },
      ],
    });
    const { cache } = makeCache({ client });

    const result = await appendToMailbox(mailboxInput(cache));

    expect(append).not.toHaveBeenCalled();
    // uid=3 - the matching envelope was the third in iteration.
    expect(result).toEqual<AppendToMailboxResult>({
      ok: true,
      deduped: true,
      uid: 3,
      uidValidity: 1,
    });
  });

  it("always releases the mailbox lock even when the probe throws", async () => {
    const { client, lockRelease } = makeClient({ existingCount: 1, searchReturnsFalse: true });
    const { cache } = makeCache({ client });

    await expect(appendToMailbox(mailboxInput(cache))).rejects.toThrow();
    expect(lockRelease).toHaveBeenCalledOnce();
  });

  it("serializes concurrent calls where messageId differs only by domain case (same canonical key)", async () => {
    // <abc@Example.COM> and <abc@example.com> are equal under canonicalMessageId
    // and must share the same pending key - otherwise both probe independently,
    // both miss, and both APPEND -> duplicate.
    const clientA = makeClient({ existingCount: 0 });
    const clientB = makeClient({
      existingCount: 1,
      candidateUids: [1],
      envelopes: [{ uid: 1, messageId: "<abc@example.com>" }],
    });

    let callIndex = 0;
    const execute = vi.fn(
      async (_id: string, _creds: ImapCredentials, fn: (c: ImapFlow) => Promise<unknown>) => {
        callIndex++;
        return fn(callIndex === 1 ? clientA.client : clientB.client);
      },
    );
    const cache = { execute } as unknown as ImapConnectionCache;

    const [resultA, resultB] = await Promise.all([
      appendToMailbox(mailboxInput(cache, { messageId: "<abc@Example.COM>" })),
      appendToMailbox(mailboxInput(cache, { messageId: "<abc@example.com>" })),
    ]);

    expect(clientA.append).toHaveBeenCalledOnce();
    expect(clientB.append).not.toHaveBeenCalled();
    expect(resultA).toMatchObject({ ok: true, deduped: false });
    expect(resultB).toMatchObject({ ok: true, deduped: true });
  });

  it("returns deduped: false with null uid/uidValidity when server does not support UIDPLUS", async () => {
    const { client, append } = makeClient({ existingCount: 0 });
    const { cache } = makeCache({ client });
    // imapflow returns a result without uid when server doesn't support UIDPLUS;
    // appendMessage falls through to { ok: true, uid: null, uidValidity: null }.
    append.mockResolvedValueOnce({ uid: undefined, uidValidity: undefined });

    const result = await appendToMailbox(mailboxInput(cache));

    expect(result).toEqual<AppendToMailboxResult>({
      ok: true,
      deduped: false,
      uid: null,
      uidValidity: null,
    });
  });

  it("serializes concurrent calls for the same account+mailbox+messageId (no duplicate)", async () => {
    // Both calls arrive before either executes. Without the pending chain,
    // both would probe "not present" and both APPEND - one duplicate copy.
    // With the chain, the second call's probe runs after the first APPEND lands
    // and finds the message, returning null instead of appending again.
    let appendCount = 0;
    const firstCallExistsCount = 0; // empty on first probe
    const secondCallExistsCount = 1; // first APPEND landed by second probe

    // First call sees an empty mailbox -> APPENDs.
    const clientA = makeClient({ existingCount: firstCallExistsCount });
    // Second call sees the message already present -> returns null.
    const clientB = makeClient({
      existingCount: secondCallExistsCount,
      candidateUids: [1],
      envelopes: [{ uid: 1, messageId: MESSAGE_ID }],
    });

    let callIndex = 0;
    const execute = vi.fn(
      async (_id: string, _creds: ImapCredentials, fn: (c: ImapFlow) => Promise<unknown>) => {
        callIndex++;
        return fn(callIndex === 1 ? clientA.client : clientB.client);
      },
    );
    const cache = { execute } as unknown as ImapConnectionCache;

    // Fire both concurrently.
    const [resultA, resultB] = await Promise.all([
      appendToMailbox(mailboxInput(cache)),
      appendToMailbox(mailboxInput(cache)),
    ]);

    clientA.append.mock.calls.forEach(() => appendCount++);
    clientB.append.mock.calls.forEach(() => appendCount++);

    expect(appendCount).toBe(1); // only one APPEND happened
    expect(resultA).toMatchObject({ ok: true, deduped: false }); // first call appended
    expect(resultB).toMatchObject({ ok: true, deduped: true }); // second call found it
  });
});

// ---------------------------------------------------------------------------
// appendToSentFolder - wrapper contract
// ---------------------------------------------------------------------------

describe("appendToSentFolder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes mailboxPath as the target and applies \\Seen flag", async () => {
    const { client, append } = makeClient({ existingCount: 0 });
    const { cache } = makeCache({ client });

    const input: AppendToSentFolderInput = {
      imapCache: cache,
      emailAccountId: "acc1",
      imapCreds,
      raw: RAW,
      mailboxPath: "INBOX.Sent",
      messageId: MESSAGE_ID,
    };

    await appendToSentFolder(input);

    expect(append).toHaveBeenCalledOnce();
    const [path, , flags] = append.mock.calls[0]!;
    expect(path).toBe("INBOX.Sent");
    expect(flags).toEqual(["\\Seen"]);
  });
});
