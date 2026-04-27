import { describe, expect, it } from "vitest";

import { fetchMessageBody } from "../body-fetch";
import { withImapConnection } from "../connection";
import { seedMessage, testCredentials } from "./setup";

const creds = () => testCredentials("bodyfetchuser");

/** Cap-policy opt-out for tests that exercise extraction behavior, not byte limits. */
const NO_CAPS = { maxBytesPerPart: Infinity, maxBytesTotal: Infinity };

/**
 * Resolve the just-appended message's UID inside `mailbox` via SEARCH ALL.
 * Each test seeds its own mailbox to avoid cross-test UID collisions (UIDs only
 * ever increase per UIDVALIDITY, so a shared INBOX would make `lastUid()` return
 * whichever message was appended last across the whole suite).
 */
async function lastUid(mailbox: string): Promise<number> {
  return withImapConnection(creds(), async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const uids = (await client.search({ all: true }, { uid: true })) || [];
      if (uids.length === 0) throw new Error(`no messages in ${mailbox}`);
      // SEARCH ALL is unordered per RFC 3501; max() picks
      // the most recent append regardless of result order.
      return Math.max(...uids);
    } finally {
      lock.release();
    }
  });
}

describe("fetchMessageBody", () => {
  it("returns text/plain content when the message has only a text/plain body", async () => {
    const mailbox = "BodyFetchPlainOnly";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, text: "Hello plain world." });
    const uid = await lastUid(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      fetchMessageBody(client, { mailbox, uid, ...NO_CAPS }),
    );

    expect(result.uidNotFound).toBe(false);
    expect(result.bodyText).toContain("Hello plain world.");
    expect(result.bodyHtml).toBeUndefined();
  });

  it("returns both bodyText and bodyHtml for a multipart/alternative message", async () => {
    // mailcomposer wraps text+html in multipart/alternative - the dominant
    // real-world shape for HTML mail. Pins that the per-part download +
    // join behaves correctly when the parser emits two text leaves.
    const mailbox = "BodyFetchAlternative";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), {
      mailbox,
      text: "alternative plain part",
      html: "<p>alternative <b>html</b> part</p>",
    });
    const uid = await lastUid(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      fetchMessageBody(client, { mailbox, uid, ...NO_CAPS }),
    );

    expect(result.uidNotFound).toBe(false);
    expect(result.bodyText).toContain("alternative plain part");
    expect(result.bodyHtml).toContain("<p>alternative <b>html</b> part</p>");
  });

  it("returns uidNotFound=true with both body fields undefined when no message matches the UID", async () => {
    // Pins the false-on-miss contract that distinguishes "moved/expunged race" from
    // "exists but has no indexable body". The caller can log these differently.
    // 2147483647 (INT32 max) is well beyond any UID a fresh test mailbox would assign.
    const mailbox = "BodyFetchUidMiss";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));

    const result = await withImapConnection(creds(), (client) =>
      fetchMessageBody(client, { mailbox, uid: 2147483647, ...NO_CAPS }),
    );

    expect(result.uidNotFound).toBe(true);
    expect(result.bodyText).toBeUndefined();
    expect(result.bodyHtml).toBeUndefined();
  });

  it("decodes quoted-printable + utf-8 charset transparently via imapflow.download", async () => {
    // Pins that we trust imapflow's Content-Transfer-Encoding + charset decoders end-to-end -
    // quoted-printable encodes "café" as "caf=C3=A9" on the wire, and a regression in our path
    // (e.g., reading the raw buffer instead of the decoded stream) would leave the literal
    // "=C3=A9" in bodyText. mailcomposer picks the encoding based on body content, so a body
    // with multi-byte characters forces quoted-printable.
    const mailbox = "BodyFetchQuotedPrintable";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    await seedMessage(creds(), { mailbox, text: "café résumé naïve" });
    const uid = await lastUid(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      fetchMessageBody(client, { mailbox, uid, ...NO_CAPS }),
    );

    expect(result.bodyText).toContain("café résumé naïve");
    expect(result.bodyText).not.toContain("=C3");
  });

  it("respects maxBytesPerPart: truncates a single oversized text part at the cap", async () => {
    // Pins the imapflow-driven truncation contract. A body larger than
    // maxBytesPerPart returns truncated bytes without throwing - that's
    // the soft-cliff behavior the worker relies on for OOM protection.
    const mailbox = "BodyFetchMaxPart";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    const big = "x".repeat(8192);
    await seedMessage(creds(), { mailbox, text: big });
    const uid = await lastUid(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      fetchMessageBody(client, {
        mailbox,
        uid,
        maxBytesPerPart: 1024,
        maxBytesTotal: Infinity,
      }),
    );

    expect(result.bodyText).toBeDefined();
    expect(result.bodyText!.length).toBeLessThan(big.length);
    expect(result.bodyText!.length).toBeLessThanOrEqual(1024);
  });

  it("respects maxBytesTotal: stops downloading further text parts after the budget is exhausted", async () => {
    // Multipart/alternative with text + html. With maxBytesTotal small enough to cover
    // only the plain part, we expect bodyText to land and bodyHtml to be skipped entirely
    // (the second download() call is never issued). Pins that the budget guard is checked
    // at the LOOP level, not just per-part.
    const mailbox = "BodyFetchMaxTotal";
    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    const plain = "p".repeat(2048);
    const html = `<p>${"h".repeat(2048)}</p>`;
    await seedMessage(creds(), { mailbox, text: plain, html });
    const uid = await lastUid(mailbox);

    const result = await withImapConnection(creds(), (client) =>
      fetchMessageBody(client, {
        mailbox,
        uid,
        maxBytesPerPart: Infinity,
        // Large enough to admit the first part, small enough that the
        // second part's bytesRemaining check trips before download().
        maxBytesTotal: 1024,
      }),
    );

    expect(result.bodyText).toBeDefined();
    expect(result.bodyHtml).toBeUndefined();
  });
});
