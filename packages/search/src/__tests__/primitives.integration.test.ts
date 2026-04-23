import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SyncedMessageDoc } from "../primitives";
import type { MessageDoc } from "../types";

import { searchClient } from "../client";
import { ensureMeilisearchConfig } from "../config";
import {
  deleteMessageDoc,
  deleteMessagesByEmailAccount,
  getMessageDoc,
  upsertMessageBody,
  upsertMessageFlags,
  upsertSyncedMessage,
} from "../primitives";
import { awaitTaskOrThrow } from "../tasks";
import { TEST_INDEX_UID } from "./helpers";

function makeSyncedMessageDoc(overrides: Partial<SyncedMessageDoc> = {}): SyncedMessageDoc {
  return {
    id: "msg_1",
    userId: "user_1",
    emailAccountId: "acct_1",
    mailboxId: "mbox_1",
    subject: "Project kickoff",
    from: ["Alice <alice@example.com>"],
    to: ["Bob <bob@example.com>"],
    cc: [],
    bcc: [],
    receivedDate: 1_700_000_000,
    sizeBytes: 4096,
    flags: ["\\Seen"],
    attachments: [
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 4096,
        contentId: null,
        disposition: "attachment",
        partPath: "2",
      },
    ],
    ...overrides,
  };
}

describe("indexing primitives", () => {
  beforeAll(async () => {
    await ensureMeilisearchConfig(searchClient, TEST_INDEX_UID);
  });

  beforeEach(async () => {
    // Clean slate so per-test ids and counts are unambiguous.
    await awaitTaskOrThrow(
      "deleteAllDocuments",
      searchClient.index(TEST_INDEX_UID).deleteAllDocuments(),
    );
  });

  it("round-trips sync-stage writes, including attachments metadata", async () => {
    const doc = makeSyncedMessageDoc();
    await upsertSyncedMessage(searchClient, doc, TEST_INDEX_UID);

    const fetched = await getMessageDoc(searchClient, doc.id, TEST_INDEX_UID);
    expect(fetched).not.toBeNull();
    expect(fetched).toMatchObject({
      id: doc.id,
      emailAccountId: doc.emailAccountId,
      subject: doc.subject,
      from: doc.from,
      to: doc.to,
      receivedDate: doc.receivedDate,
      flags: doc.flags,
      attachments: doc.attachments,
    });
  });

  it("returns null for an unknown id", async () => {
    expect(await getMessageDoc(searchClient, "missing_id", TEST_INDEX_UID)).toBeNull();
  });

  it("re-dispatch preserves later-stage body fields and replaces stale attachments", async () => {
    // Realistic reparse: the sync-stage event re-fires after body-fetch has
    // enriched the doc, and the attachment list has shrunk to zero (e.g. a
    // reparse that no longer recognizes a part as an attachment). The
    // upsert must (a) leave bodyText/bodyHtml intact - `updateDocuments`
    // is partial-merge - and (b) replace the prior attachments array with
    // the new explicit `[]` rather than leave stale entries behind.
    const id = "msg_redispatch";
    await upsertSyncedMessage(searchClient, makeSyncedMessageDoc({ id }), TEST_INDEX_UID);
    await upsertMessageBody(
      searchClient,
      id,
      { bodyText: "indexed body", bodyHtml: "<p>indexed body</p>" },
      TEST_INDEX_UID,
    );

    await upsertSyncedMessage(
      searchClient,
      makeSyncedMessageDoc({ id, attachments: [] }),
      TEST_INDEX_UID,
    );

    const fetched = (await getMessageDoc(searchClient, id, TEST_INDEX_UID)) as MessageDoc;
    expect(fetched.bodyText).toBe("indexed body");
    expect(fetched.bodyHtml).toBe("<p>indexed body</p>");
    expect(fetched.attachments).toEqual([]);
  });

  it("upsertMessageFlags updates flags without touching headers, attachments, or body", async () => {
    // Pins the surgical-partial contract: flag sync must not rewrite
    // header fields or attachment lists, and must preserve any
    // later-stage body enrichment. A regression that expanded
    // upsertMessageFlags's payload would silently clobber those fields.
    const doc = makeSyncedMessageDoc({ id: "msg_flags", flags: ["\\Seen"] });
    await upsertSyncedMessage(searchClient, doc, TEST_INDEX_UID);
    await upsertMessageBody(
      searchClient,
      doc.id,
      { bodyText: "hello", bodyHtml: "<p>hello</p>" },
      TEST_INDEX_UID,
    );

    await upsertMessageFlags(searchClient, doc.id, ["\\Seen", "\\Flagged"], TEST_INDEX_UID);

    const fetched = (await getMessageDoc(searchClient, doc.id, TEST_INDEX_UID)) as MessageDoc;
    expect(fetched.flags).toEqual(["\\Seen", "\\Flagged"]);
    expect(fetched.subject).toBe(doc.subject);
    expect(fetched.from).toEqual(doc.from);
    expect(fetched.attachments).toEqual(doc.attachments);
    expect(fetched.bodyText).toBe("hello");
    expect(fetched.bodyHtml).toBe("<p>hello</p>");
  });

  it("accepts partial body writes that preserve the other body field", async () => {
    const doc = makeSyncedMessageDoc({ id: "msg_partial_body" });
    await upsertSyncedMessage(searchClient, doc, TEST_INDEX_UID);

    await upsertMessageBody(searchClient, doc.id, { bodyText: "plain only" }, TEST_INDEX_UID);
    const afterText = (await getMessageDoc(searchClient, doc.id, TEST_INDEX_UID)) as MessageDoc;
    expect(afterText.bodyText).toBe("plain only");
    expect(afterText.bodyHtml).toBeUndefined();

    await upsertMessageBody(
      searchClient,
      doc.id,
      { bodyHtml: "<p>html added</p>" },
      TEST_INDEX_UID,
    );
    const afterHtml = (await getMessageDoc(searchClient, doc.id, TEST_INDEX_UID)) as MessageDoc;
    expect(afterHtml.bodyText).toBe("plain only");
    expect(afterHtml.bodyHtml).toBe("<p>html added</p>");
  });

  it("deleteMessageDoc returns 0 for an unknown id", async () => {
    const count = await deleteMessageDoc(searchClient, "never_indexed", TEST_INDEX_UID);
    expect(count).toBe(0);
  });

  it("deleteMessageDoc returns 1 and removes the doc for a known id", async () => {
    const doc = makeSyncedMessageDoc({ id: "msg_delete" });
    await upsertSyncedMessage(searchClient, doc, TEST_INDEX_UID);

    const count = await deleteMessageDoc(searchClient, doc.id, TEST_INDEX_UID);
    expect(count).toBe(1);
    expect(await getMessageDoc(searchClient, doc.id, TEST_INDEX_UID)).toBeNull();
  });

  it("partial body upserts against a missing id create an orphan unreachable by emailAccountId filter", async () => {
    // Pins the documented hazard: Meilisearch's `updateDocuments` creates
    // the doc if missing, leaving only the partial fields set. With no
    // `emailAccountId`, the orphan escapes tenant-scoped cleanup.
    // `upsertMessageBody` and `upsertMessageFlags` both share this shape
    // (`{id, ...partial}`); only `upsertMessageBody` is exercised here
    // since the Meilisearch behavior under test is identical for both.
    const orphanId = "orphan_msg";
    await upsertMessageBody(searchClient, orphanId, { bodyText: "orphaned text" }, TEST_INDEX_UID);

    // Reachable by direct id lookup.
    const fetched = (await getMessageDoc(searchClient, orphanId, TEST_INDEX_UID)) as MessageDoc;
    expect(fetched.bodyText).toBe("orphaned text");
    expect(fetched.emailAccountId).toBeUndefined();

    // Unreachable by tenant-scoped cleanup - zero matches, orphan survives.
    const removed = await deleteMessagesByEmailAccount(searchClient, "acct_1", TEST_INDEX_UID);
    expect(removed).toBe(0);
    expect(await getMessageDoc(searchClient, orphanId, TEST_INDEX_UID)).not.toBeNull();
  });

  it("deleteMessagesByEmailAccount removes only the targeted account and returns the count", async () => {
    await upsertSyncedMessage(
      searchClient,
      makeSyncedMessageDoc({ id: "a1", emailAccountId: "acct_A" }),
      TEST_INDEX_UID,
    );
    await upsertSyncedMessage(
      searchClient,
      makeSyncedMessageDoc({ id: "a2", emailAccountId: "acct_A" }),
      TEST_INDEX_UID,
    );
    await upsertSyncedMessage(
      searchClient,
      makeSyncedMessageDoc({ id: "b1", emailAccountId: "acct_B" }),
      TEST_INDEX_UID,
    );

    const removed = await deleteMessagesByEmailAccount(searchClient, "acct_A", TEST_INDEX_UID);
    expect(removed).toBe(2);

    expect(await getMessageDoc(searchClient, "a1", TEST_INDEX_UID)).toBeNull();
    expect(await getMessageDoc(searchClient, "a2", TEST_INDEX_UID)).toBeNull();
    expect(await getMessageDoc(searchClient, "b1", TEST_INDEX_UID)).not.toBeNull();

    // No-match run resolves with 0, still idempotent.
    const zero = await deleteMessagesByEmailAccount(searchClient, "acct_A", TEST_INDEX_UID);
    expect(zero).toBe(0);
  });

  it("rejects an emailAccountId that would break the filter expression", async () => {
    await expect(
      deleteMessagesByEmailAccount(searchClient, 'acct" OR 1=1', TEST_INDEX_UID),
    ).rejects.toThrow(/unsafe emailAccountId/);
  });
});
