import type { Meilisearch } from "@kirimail/search";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  cleanImapState,
  createEncryptedEmailAccount,
  createTestDb,
  createTestMeiliClient,
  createTestUser,
  ensureTestMeilisearchConfig,
  resetTestIndex,
  TEST_INDEX_UID,
} from "#test/helpers";
import { insertDomainEvent } from "@kirimail/db";
import * as schema from "@kirimail/db/schema";
import { ImapConnectionCache, ImapNonRetriableError } from "@kirimail/mail";
import { seedMessage, testCredentials, withImapConnection } from "@kirimail/mail/testing";
import { getMessageDoc, upsertSyncedMessage } from "@kirimail/search";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerEventDispatcher, registerFetchBody, registerSyncEmailAccount } from "..";
import { handleEventDispatcher } from "../event-dispatcher";
import { FETCH_BODY_QUEUE, handleFetchBody } from "../fetch-body";

type Db = NodePgDatabase<typeof schema>;

/** Default batch size for direct-invocation dispatcher tests. */
const TEST_BATCH_SIZE = 100;

let db: Db;
let pool: Pool;
let meili: Meilisearch;

beforeAll(async () => {
  const testDb = createTestDb();
  db = testDb.db;
  pool = testDb.pool;
  meili = createTestMeiliClient();
  await ensureTestMeilisearchConfig(meili);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Reverse FK order, then users.
  await db.delete(schema.domainEventConsumers);
  await db.delete(schema.domainEvents);
  await db.delete(schema.messages);
  await db.delete(schema.mailboxes);
  await db.delete(schema.emailAccounts);
  await db.delete(schema.users);

  await resetTestIndex(meili);
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedRowInput {
  encrypted?: boolean;
  providerUid?: number;
  mailboxPath?: string;
  emailUser?: string;
}

/**
 * Insert a user, email account, mailbox, and `messages` row in one go.
 * Mirrors the dispatcher test's helper but exposes `encrypted` and
 * `providerUid` so fetch-body branches can be exercised without going
 * through the full sync pipeline.
 */
async function seedMessageRow(input: SeedRowInput = {}) {
  const userId = await createTestUser(db);
  const emailAccountId = await createEncryptedEmailAccount(db, userId, {
    emailUser: input.emailUser,
  });
  const mailboxId = randomUUID();
  await db.insert(schema.mailboxes).values({
    id: mailboxId,
    emailAccountId,
    path: input.mailboxPath ?? "INBOX",
    role: "inbox",
  });

  const messageId = randomUUID();
  await db.insert(schema.messages).values({
    id: messageId,
    mailboxId,
    providerUid: input.providerUid ?? 1,
    uidValidity: 1,
    subject: "Body fetch test",
    fromAddress: [{ name: "Alice", address: "alice@example.com" }],
    toAddress: [{ name: "Bob", address: "bob@example.com" }],
    flags: ["\\Seen"],
    attachments: [],
    encrypted: input.encrypted ?? false,
    internalDate: new Date("2026-01-01T00:00:00Z"),
    sizeOctets: 1234,
  });

  return { messageId, mailboxId, emailAccountId, userId };
}

/**
 * Pre-populate the Meilisearch doc for a message id with the same shape
 * the dispatcher would write. Body-population tests rely on it existing
 * so the partial-merge upsert lands; the orphan-guard test deletes this
 * doc before invoking the worker.
 */
async function seedMeiliHeaderDoc(opts: {
  messageId: string;
  emailAccountId: string;
  mailboxId: string;
  userId: string;
  encrypted?: boolean;
}) {
  await upsertSyncedMessage(
    meili,
    {
      id: opts.messageId,
      userId: opts.userId,
      emailAccountId: opts.emailAccountId,
      mailboxId: opts.mailboxId,
      subject: "Body fetch test",
      from: ["Alice <alice@example.com>"],
      to: ["Bob <bob@example.com>"],
      cc: [],
      bcc: [],
      receivedDate: Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000),
      sizeBytes: 1234,
      flags: ["\\Seen"],
      encrypted: opts.encrypted ?? false,
      attachments: [],
    },
    TEST_INDEX_UID,
  );
}

// ---------------------------------------------------------------------------
// FakeBoss: records boss.send invocations
// ---------------------------------------------------------------------------

interface FakeBoss extends PgBoss {
  sends: Array<{ name: string; data: unknown }>;
}

function createFakeBoss(): FakeBoss {
  const sends: Array<{ name: string; data: unknown }> = [];
  return {
    sends,
    send: async (name: string, data?: unknown) => {
      sends.push({ name, data });
      return "fake-job-id";
    },
  } as unknown as FakeBoss;
}

// ---------------------------------------------------------------------------
// Direct-invocation worker tests (early-return paths)
// ---------------------------------------------------------------------------

describe("handleFetchBody (early-return paths)", () => {
  // Each test uses a private cache so the per-account inactivity timer
  // doesn't cross test boundaries. Close in afterEach so we don't leak
  // open IMAP sessions to Stalwart - the inactivity timer (60s default)
  // would eventually evict, but across a long run the session count grows.
  let cache: ImapConnectionCache;
  beforeEach(() => {
    cache = new ImapConnectionCache();
  });
  afterEach(() => {
    cache.closeAll();
  });

  it("returns cleanly when the message row no longer exists", async () => {
    // Simulates the race where `message.deleted` consumed between
    // dispatcher enqueue and worker execution. Worker must not throw.
    await expect(
      handleFetchBody({
        db,
        meili,
        imapCache: cache,
        messageId: "missing-id",
        indexUid: TEST_INDEX_UID,
      }),
    ).resolves.toBeUndefined();
  });

  it("skips when the Meilisearch doc is absent (pre-IMAP orphan guard)", async () => {
    // The first of two orphan-doc guards: if the doc is already gone
    // before we touch IMAP, exit early. Without this branch the worker
    // would do mailboxOpen -> fetchOne -> for-each download (potentially
    // MB of bytes) only to discard them at the late guard.
    const { messageId } = await seedMessageRow();
    // Deliberately do NOT seed the Meilisearch header doc; pre-IMAP
    // guard sees absence and exits before any IMAP call would fail.

    await handleFetchBody({
      db,
      meili,
      imapCache: cache,
      messageId,
      indexUid: TEST_INDEX_UID,
    });

    expect(await getMessageDoc(meili, messageId, TEST_INDEX_UID)).toBeNull();
  });

  it("skips when bodyText/bodyHtml is already populated (idempotent re-dispatch)", async () => {
    // Pins the no-IMAP-on-re-run behavior: a duplicate fetch-body enqueue
    // (boss.send retried after a transient failure, or dispatcher re-ran
    // a `message.synced` event because markDomainEventConsumed lost a
    // race) must not pull the body bytes again. Pre-seed the doc with
    // body fields and assert the worker returns without changing them
    // and without hitting IMAP - we use a bogus mailboxPath so that any
    // IMAP traffic at all would fail mailboxOpen.
    const { messageId, mailboxId, emailAccountId, userId } = await seedMessageRow({
      mailboxPath: "Mailbox/Does/Not/Exist",
    });
    await seedMeiliHeaderDoc({ messageId, mailboxId, emailAccountId, userId });
    await meili
      .index(TEST_INDEX_UID)
      .updateDocuments([{ id: messageId, bodyText: "preserved", bodyHtml: "<p>preserved</p>" }])
      .waitTask();

    await handleFetchBody({
      db,
      meili,
      imapCache: cache,
      messageId,
      indexUid: TEST_INDEX_UID,
    });

    const doc = await getMessageDoc(meili, messageId, TEST_INDEX_UID);
    expect(doc!.bodyText).toBe("preserved");
    expect(doc!.bodyHtml).toBe("<p>preserved</p>");
  });

  it("throws ImapNonRetriableError when the server mailbox doesn't exist", async () => {
    // Pin the deterministic-discard contract for the worker: when SELECT/EXAMINE
    // returns NO (mailbox renamed or deleted server-side), fetchMessageBody must
    // surface that as a typed non-retriable so the worker discards instead of
    // burning pg-boss's retry budget. We seed real Stalwart credentials and a
    // Meili header doc with no body fields so we can't short-circuit on either
    // pre-IMAP guard - the worker actually opens an IMAP connection and calls
    // EXAMINE on a path that doesn't exist on the server.
    const { messageId, emailAccountId, mailboxId, userId } = await seedMessageRow({
      mailboxPath: "Mailbox/Does/Not/Exist",
      emailUser: "fbuser",
    });
    await seedMeiliHeaderDoc({ messageId, emailAccountId, mailboxId, userId });

    const promise = handleFetchBody({
      db,
      meili,
      imapCache: cache,
      messageId,
      indexUid: TEST_INDEX_UID,
    });
    await expect(promise).rejects.toBeInstanceOf(ImapNonRetriableError);
    // Pin that the original imapflow error survives on `cause` - postmortems
    // need responseStatus/executedCommand to identify the failing operation.
    await expect(promise).rejects.toMatchObject({
      cause: expect.objectContaining({ responseStatus: "NO" }),
    });
  });

  it("skips when the row is flagged encrypted (defense-in-depth)", async () => {
    // The dispatcher should skip enqueueing in the first place, but a future composer
    // (e.g., reindex) might call the function directly. Pre-seed the Meili doc with
    // `encrypted: true` and assert the body fields remain absent after the worker
    // returns - i.e., no upsertMessageBody happened.
    //
    // The mailboxPath points at a path that doesn't exist on the server, so any IMAP
    // work past the encrypted guard would crash mailboxOpen. That makes the assertion
    // ironclad: if the encrypted check is ever moved BELOW the IMAP block, this test
    // fails noisily instead of passing for the wrong reason (e.g., reaching IMAP,
    // finding no UID, and exiting via the "uid not on server" branch).
    const { messageId, emailAccountId, mailboxId, userId } = await seedMessageRow({
      encrypted: true,
      mailboxPath: "Mailbox/Does/Not/Exist",
    });
    await seedMeiliHeaderDoc({ messageId, emailAccountId, mailboxId, userId, encrypted: true });

    await handleFetchBody({
      db,
      meili,
      imapCache: cache,
      messageId,
      indexUid: TEST_INDEX_UID,
    });

    const doc = await getMessageDoc(meili, messageId, TEST_INDEX_UID);
    expect(doc).not.toBeNull();
    expect(doc!.encrypted).toBe(true);
    expect(doc!.bodyText).toBeUndefined();
    expect(doc!.bodyHtml).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatcher fetch-body enqueue policy
// ---------------------------------------------------------------------------

describe("dispatcher fetch-body enqueue", () => {
  it("enqueues fetch-body after a successful header upsert for non-encrypted messages", async () => {
    const { messageId } = await seedMessageRow();
    await insertDomainEvent(db, {
      aggregateType: "message",
      aggregateId: messageId,
      eventType: "message.synced",
    });

    const boss = createFakeBoss();
    await handleEventDispatcher({
      db,
      meili,
      boss,
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });

    // Exactly one fetch-body enqueue, carrying the message id.
    const fetchSends = boss.sends.filter((s) => s.name === FETCH_BODY_QUEUE);
    expect(fetchSends).toHaveLength(1);
    expect(fetchSends[0]!.data).toEqual({ messageId });
  });

  it("does NOT enqueue fetch-body when the message is flagged encrypted", async () => {
    // The cheap producer-side filter: a message that can't be indexed
    // shouldn't take a queue row. Mirrors the worker's defense-in-depth
    // skip; this test pins the policy at the dispatcher.
    const { messageId } = await seedMessageRow({ encrypted: true });
    await insertDomainEvent(db, {
      aggregateType: "message",
      aggregateId: messageId,
      eventType: "message.synced",
    });

    const boss = createFakeBoss();
    await handleEventDispatcher({
      db,
      meili,
      boss,
      indexUid: TEST_INDEX_UID,
      batchSize: TEST_BATCH_SIZE,
    });

    // Header upsert still happens (encrypted: true is a UI signal).
    const doc = await getMessageDoc(meili, messageId, TEST_INDEX_UID);
    expect(doc).not.toBeNull();
    expect(doc!.encrypted).toBe(true);

    // But no fetch-body job was queued.
    const fetchSends = boss.sends.filter((s) => s.name === FETCH_BODY_QUEUE);
    expect(fetchSends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end via pg-boss: sync -> dispatcher -> fetch-body chain
// ---------------------------------------------------------------------------

function createTestBoss() {
  return new PgBoss({
    db: {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await pool.query(text, values);
        return { rows: result.rows };
      },
    },
    schema: "pgboss",
    __test__enableSpies: true,
  });
}

describe("end-to-end sync -> dispatcher -> fetch-body via pg-boss", () => {
  // Dedicated principal isolates this suite from other suites' INBOX state.
  const e2eCreds = () => testCredentials("fbe2euser");

  beforeEach(async () => {
    await cleanImapState(e2eCreds());
  });

  it("populates body fields in Meilisearch after the full chain runs", async () => {
    const userId = await createTestUser(db);
    const accountId = await createEncryptedEmailAccount(db, userId, {
      emailUser: "fbe2euser",
    });

    await seedMessage(e2eCreds(), {
      headers: { subject: "End-to-end body" },
      text: "End-to-end body text.",
      html: "<p>End-to-end <b>body</b> html.</p>",
    });

    const boss = createTestBoss();
    await boss.start();
    try {
      // Registration order matches production startup: fetch-body before
      // dispatcher (dispatcher enqueues into it), dispatcher before sync
      // (sync enqueues dispatcher ticks).
      await registerFetchBody(boss, { indexUid: TEST_INDEX_UID });
      await registerEventDispatcher(boss, {
        indexUid: TEST_INDEX_UID,
        batchSize: TEST_BATCH_SIZE,
      });
      await registerSyncEmailAccount(boss);

      const syncSpy = boss.getSpy<{ emailAccountId: string }>("sync-email-account");

      await boss.send(
        "sync-email-account",
        { emailAccountId: accountId },
        { singletonKey: accountId },
      );

      // Wait for THIS account's sync to land - filtering by accountId
      // protects against a future code change that emits a second sync
      // job from inside the chain (e.g., a follow-up self-trigger), which
      // a bare `() => true` predicate would match silently. The post-sync
      // trigger enqueues a dispatcher tick which enqueues fetch-body for
      // each synced message; we poll for the body convergence below
      // rather than spying on dispatcher/fetch-body completion (their job
      // ids aren't stable across the sync->dispatcher->fetch-body chain
      // in a way that waitForJob can match cleanly).
      await syncSpy.waitForJob((data) => data.emailAccountId === accountId, "completed");

      // Poll for body convergence: dispatcher fires after sync,
      // fetch-body fires after dispatcher, and Meilisearch's task
      // pipeline runs through before either worker returns. Bound the
      // wait so a regression doesn't hang the suite.
      const deadline = Date.now() + 30_000;
      let docWithBody: Awaited<ReturnType<typeof getMessageDoc>> = null;
      while (Date.now() < deadline) {
        const rows = await db.select().from(schema.messages);
        if (rows.length === 1) {
          const doc = await getMessageDoc(meili, rows[0]!.id, TEST_INDEX_UID);
          if (doc?.bodyText !== undefined || doc?.bodyHtml !== undefined) {
            docWithBody = doc;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(docWithBody).not.toBeNull();
      expect(docWithBody!.bodyText).toContain("End-to-end body text.");
      expect(docWithBody!.bodyHtml).toContain("<p>End-to-end <b>body</b> html.</p>");
      // E2E's job is plumbing (sync -> dispatcher -> fetch-body all wired
      // up correctly). Derivation semantics (no-derive when bodyText is
      // real) live in the focused multipart test below.
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});

// ---------------------------------------------------------------------------
// Body derivation: HTML-only mail is the only path that writes the search-only
// `bodyTextDerived` field. Direct-invocation tests (instead of the full sync
// chain) target the worker's branches on known-shape messages.
// ---------------------------------------------------------------------------

describe("body derivation from HTML", () => {
  let cache: ImapConnectionCache;
  beforeEach(() => {
    cache = new ImapConnectionCache();
  });
  afterEach(() => {
    cache.closeAll();
  });

  /**
   * Append a real message to the user's INBOX, resolve its UID, and create
   * matching DB rows + Meilisearch header doc. Lets handleFetchBody run as
   * if dispatcher had just enqueued it, without driving the full
   * sync -> dispatcher -> fetch-body chain.
   */
  async function setupImapMessage(opts: {
    emailUser: string;
    seed: Parameters<typeof seedMessage>[1];
  }) {
    const creds = testCredentials(opts.emailUser);
    await cleanImapState(creds);
    await seedMessage(creds, opts.seed);

    const uid = await withImapConnection(creds, async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const uids = (await client.search({ all: true }, { uid: true })) || [];
        if (uids.length === 0) throw new Error("no messages in INBOX after seed");
        // SEARCH ALL is unordered per RFC 3501; max() picks the latest append.
        return Math.max(...uids);
      } finally {
        lock.release();
      }
    });

    const userId = await createTestUser(db);
    const emailAccountId = await createEncryptedEmailAccount(db, userId, {
      emailUser: opts.emailUser,
    });
    const mailboxId = randomUUID();
    await db.insert(schema.mailboxes).values({
      id: mailboxId,
      emailAccountId,
      path: "INBOX",
      role: "inbox",
    });
    const messageId = randomUUID();
    await db.insert(schema.messages).values({
      id: messageId,
      mailboxId,
      providerUid: uid,
      uidValidity: 1,
      subject: opts.seed?.headers?.subject ?? null,
      fromAddress: [{ name: "Sender", address: "sender@localhost" }],
      toAddress: [{ name: "User", address: `${opts.emailUser}@localhost` }],
      flags: [],
      attachments: [],
      encrypted: false,
      internalDate: new Date("2026-01-01T00:00:00Z"),
      sizeOctets: 1024,
    });
    await seedMeiliHeaderDoc({ messageId, mailboxId, emailAccountId, userId });
    return { messageId, emailAccountId, mailboxId, userId };
  }

  it("HTML-only mail derives bodyTextDerived; bodyText stays undefined", async () => {
    // Production scenario: mailing list / marketing / transactional mail with
    // a single text/html MIME part and no text/plain alternative. Without
    // derivation, the body content is unsearchable because bodyHtml is not
    // in `searchableAttributes`.
    const { messageId } = await setupImapMessage({
      emailUser: "fbderiveuser",
      seed: {
        headers: { subject: "HTML only" },
        html: "<p>Hello <b>world</b> from HTML-only mail.</p>",
      },
    });

    await handleFetchBody({
      db,
      meili,
      imapCache: cache,
      messageId,
      indexUid: TEST_INDEX_UID,
    });

    const doc = await getMessageDoc(meili, messageId, TEST_INDEX_UID);
    expect(doc).not.toBeNull();
    expect(doc!.bodyText).toBeUndefined();
    expect(doc!.bodyHtml).toContain("<p>Hello <b>world</b> from HTML-only mail.</p>");
    expect(doc!.bodyTextDerived).toBeDefined();
    expect(doc!.bodyTextDerived).toContain("Hello");
    expect(doc!.bodyTextDerived).toContain("world");
    expect(doc!.bodyTextDerived).toContain("from HTML-only mail.");
  });

  it("multipart/alternative keeps original text/plain and does NOT derive", async () => {
    // Pins the worker's guard: when bodyText is real, bodyTextDerived stays
    // absent. The seed uses a token ("html") that only appears on the HTML
    // side, so a regression that always derived would surface as
    // bodyTextDerived defined and "html" leaking into bodyText's vocabulary.
    const { messageId } = await setupImapMessage({
      emailUser: "fbnoderiveuser",
      seed: {
        headers: { subject: "Multipart alternative" },
        text: "Original plain text content.",
        html: "<p>Different <b>html</b> content here.</p>",
      },
    });

    await handleFetchBody({
      db,
      meili,
      imapCache: cache,
      messageId,
      indexUid: TEST_INDEX_UID,
    });

    const doc = await getMessageDoc(meili, messageId, TEST_INDEX_UID);
    expect(doc).not.toBeNull();
    expect(doc!.bodyText).toContain("Original plain text content.");
    expect(doc!.bodyText).not.toContain("html");
    expect(doc!.bodyHtml).toContain("<p>Different <b>html</b> content here.</p>");
    expect(doc!.bodyTextDerived).toBeUndefined();
  });

  it("image-only HTML preserves bodyHtml for rendering but yields no bodyTextDerived", async () => {
    // The htmlToPlainText helper skips <img> entirely (default `image`
    // formatter would emit the cid:/tracking-pixel URL - junk in the
    // index). With no other text content, derivation returns undefined.
    // bodyHtml still gets written so the UI can render the image; the
    // message simply has no body tokens to score against in search.
    const { messageId } = await setupImapMessage({
      emailUser: "fbimgonlyuser",
      seed: {
        headers: { subject: "Image only" },
        html: '<p><img src="cid:placeholder@example"></p>',
      },
    });

    await handleFetchBody({
      db,
      meili,
      imapCache: cache,
      messageId,
      indexUid: TEST_INDEX_UID,
    });

    const doc = await getMessageDoc(meili, messageId, TEST_INDEX_UID);
    expect(doc).not.toBeNull();
    expect(doc!.bodyText).toBeUndefined();
    expect(doc!.bodyHtml).toContain('<img src="cid:placeholder@example">');
    expect(doc!.bodyTextDerived).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Worker discard via pg-boss: registered handler must mark the job complete
// (not failed) when fetchMessageBody surfaces a deterministic IMAP failure.
// ---------------------------------------------------------------------------

describe("registered worker discards deterministic IMAP failures", () => {
  it("auth failure (rotated credentials) ends the job in completed, not failed", async () => {
    // Pins the catch-arm + asNonRetriableImapError wrap for fetch-body: a
    // rotated-credentials job must end in `completed`, not retry to exhaustion.
    // If the wrap or the `instanceof` arm regress, waitForJob times out at 60s.
    const userId = await createTestUser(db);
    const accountId = await createEncryptedEmailAccount(db, userId, {
      emailUser: "fbuser",
      emailPass: "wrong-password",
    });
    const mailboxId = randomUUID();
    await db.insert(schema.mailboxes).values({
      id: mailboxId,
      emailAccountId: accountId,
      path: "INBOX",
      role: "inbox",
    });

    const messageId = randomUUID();
    await db.insert(schema.messages).values({
      id: messageId,
      mailboxId,
      providerUid: 1,
      uidValidity: 1,
      subject: "Auth failure discard test",
      fromAddress: [{ name: "Alice", address: "alice@example.com" }],
      toAddress: [{ name: "Bob", address: "bob@example.com" }],
      flags: ["\\Seen"],
      attachments: [],
      encrypted: false,
      internalDate: new Date("2026-01-01T00:00:00Z"),
      sizeOctets: 1234,
    });
    // Seed Meili header doc without body fields so the worker's pre-IMAP
    // guard doesn't short-circuit before the auth attempt.
    await seedMeiliHeaderDoc({ messageId, mailboxId, emailAccountId: accountId, userId });

    const boss = createTestBoss();
    await boss.start();
    try {
      await registerFetchBody(boss, { indexUid: TEST_INDEX_UID });

      const fetchSpy = boss.getSpy<{ messageId: string }>(FETCH_BODY_QUEUE);
      await boss.send(FETCH_BODY_QUEUE, { messageId });

      await fetchSpy.waitForJob((data) => data.messageId === messageId, "completed");
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  });
});
