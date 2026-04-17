import { afterEach, describe, expect, it } from "vitest";

import type { ImapCredentials } from "../connection";

import { ImapConnectionCache, withImapConnection } from "../connection";
import { appendToSentFolder } from "../mailbox-append";
import { seedMessage, testCredentials } from "./setup";

const creds = (): ImapCredentials => testCredentials("mailboxuploaduser");

/**
 * Read all Message-IDs from a mailbox via FETCH ENVELOPE. Reliable across
 * IMAP servers because ENVELOPE is parsed at APPEND time, unlike SEARCH
 * HEADER Message-ID which hits the server's FTS on some providers (e.g.,
 * Stalwart) and lags for seconds after APPEND.
 */
async function listMessageIds(mailbox: string): Promise<string[]> {
  return withImapConnection(creds(), async (client) => {
    await client.mailboxOpen(mailbox, { readOnly: true });
    const ids: string[] = [];
    if (client.mailbox && client.mailbox.exists === 0) return ids;
    for await (const msg of client.fetch("1:*", { envelope: true })) {
      if (msg.envelope?.messageId) ids.push(msg.envelope.messageId);
    }
    return ids;
  });
}

describe("appendToSentFolder (integration)", () => {
  let cache: ImapConnectionCache;

  afterEach(() => {
    cache?.closeAll();
  });

  function buildInput(mailbox: string, messageId: string, raw: Buffer) {
    cache = new ImapConnectionCache();
    return {
      imapCache: cache,
      emailAccountId: "mailboxuploaduser",
      imapCreds: creds(),
      raw,
      mailboxPath: mailbox,
      messageId,
    };
  }

  function buildRaw(messageId: string): Buffer {
    return Buffer.from(
      [
        "From: sender@localhost",
        "To: mailboxuploaduser@localhost",
        `Message-ID: ${messageId}`,
        "",
        "body",
      ].join("\r\n"),
    );
  }

  it("dedup hit: skips APPEND when Message-ID is already in Sent", async () => {
    const mailbox = "MailboxUploadDedupHit";
    const messageId = "<dedup-hit-123@example.com>";

    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    // Seeded message mirrors the server-side state after a "lost response"
    // APPEND - the copy landed but the client saw a disconnect. The probe
    // runs immediately after seeding, which is the Stalwart FTS-lag case
    // the SEARCH SINCE + FETCH ENVELOPE design targets.
    await seedMessage(creds(), { mailbox, headers: { messageId } });

    await appendToSentFolder(buildInput(mailbox, messageId, buildRaw(messageId)));

    const ids = await listMessageIds(mailbox);
    expect(ids.filter((id) => id === messageId)).toHaveLength(1);
  });

  it("dedup hit: finds the target among other recent messages in Sent", async () => {
    const mailbox = "MailboxUploadDedupHitNoise";
    const messageId = "<dedup-hit-among-noise@example.com>";

    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));
    // Pre-seed unrelated messages so the FETCH iteration walks past non-matches
    // before hitting the target. Exercises the real iterate-and-match path.
    await seedMessage(creds(), { mailbox, headers: { messageId: "<noise-a@example.com>" } });
    await seedMessage(creds(), { mailbox, headers: { messageId } });
    await seedMessage(creds(), { mailbox, headers: { messageId: "<noise-b@example.com>" } });

    await appendToSentFolder(buildInput(mailbox, messageId, buildRaw(messageId)));

    const ids = await listMessageIds(mailbox);
    expect(ids.filter((id) => id === messageId)).toHaveLength(1);
    expect(ids).toHaveLength(3);
  });

  it("probe is scoped to the target mailbox (no cross-mailbox dedup)", async () => {
    // If someone refactors the probe to search server-wide, a Message-ID already
    // in INBOX would cause the Sent append to be skipped - silent data loss.
    const sent = "MailboxUploadScopeSent";
    const inbox = "MailboxUploadScopeInbox";
    const messageId = "<scope-test-111@example.com>";

    await withImapConnection(creds(), async (client) => {
      await client.mailboxCreate(sent);
      await client.mailboxCreate(inbox);
    });
    await seedMessage(creds(), { mailbox: inbox, headers: { messageId } });

    await appendToSentFolder(buildInput(sent, messageId, buildRaw(messageId)));

    const sentIds = await listMessageIds(sent);
    expect(sentIds.filter((id) => id === messageId)).toHaveLength(1);
  });

  it("idempotent: calling twice does not duplicate the Sent copy", async () => {
    const mailbox = "MailboxUploadIdempotent";
    const messageId = "<idempotent-789@example.com>";
    const raw = buildRaw(messageId);

    await withImapConnection(creds(), (client) => client.mailboxCreate(mailbox));

    await appendToSentFolder(buildInput(mailbox, messageId, raw));
    await appendToSentFolder(buildInput(mailbox, messageId, raw));

    const ids = await listMessageIds(mailbox);
    expect(ids.filter((id) => id === messageId)).toHaveLength(1);
  });
});
