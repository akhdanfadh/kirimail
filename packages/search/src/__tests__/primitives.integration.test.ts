import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { HeaderDoc } from "../primitives";
import type { MessageDoc } from "../types";

import { searchClient } from "../client";
import { ensureMeilisearchConfig } from "../config";
import {
  deleteMessageDoc,
  deleteMessagesByEmailAccount,
  getMessageDoc,
  upsertMessageAttachments,
  upsertMessageBody,
  upsertMessageHeaders,
} from "../primitives";
import { awaitTaskOrThrow } from "../tasks";
import { TEST_INDEX_UID } from "./helpers";

function makeHeader(overrides: Partial<HeaderDoc> = {}): HeaderDoc {
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

  it("round-trips header writes via getMessageDoc", async () => {
    const header = makeHeader();
    await upsertMessageHeaders(searchClient, header, TEST_INDEX_UID);

    const fetched = await getMessageDoc(searchClient, header.id, TEST_INDEX_UID);
    expect(fetched).not.toBeNull();
    expect(fetched).toMatchObject({
      id: header.id,
      emailAccountId: header.emailAccountId,
      subject: header.subject,
      from: header.from,
      to: header.to,
      receivedDate: header.receivedDate,
      flags: header.flags,
    });
  });

  it("returns null for an unknown id", async () => {
    expect(await getMessageDoc(searchClient, "missing_id", TEST_INDEX_UID)).toBeNull();
  });

  it("re-running upsertMessageHeaders preserves later-stage attachment enrichment", async () => {
    const header = makeHeader({ id: "msg_redispatch" });
    await upsertMessageHeaders(searchClient, header, TEST_INDEX_UID);
    await upsertMessageAttachments(
      searchClient,
      header.id,
      [{ filename: "a.txt", mimeType: "text/plain", size: 10 }],
      TEST_INDEX_UID,
    );

    // Re-running the header upsert against the same id must not strip attachments.
    await upsertMessageHeaders(searchClient, header, TEST_INDEX_UID);

    const fetched = (await getMessageDoc(searchClient, header.id, TEST_INDEX_UID)) as MessageDoc;
    expect(fetched.attachments).toHaveLength(1);
  });

  it("layers body fields over headers and attachments without overwriting them", async () => {
    const header = makeHeader({ id: "msg_body" });
    await upsertMessageHeaders(searchClient, header, TEST_INDEX_UID);
    await upsertMessageAttachments(
      searchClient,
      header.id,
      [{ filename: "a.pdf", mimeType: "application/pdf", size: 100 }],
      TEST_INDEX_UID,
    );
    await upsertMessageBody(
      searchClient,
      header.id,
      { bodyText: "Hello world", bodyHtml: "<p>Hello world</p>" },
      TEST_INDEX_UID,
    );

    const fetched = (await getMessageDoc(searchClient, header.id, TEST_INDEX_UID)) as MessageDoc;
    expect(fetched.subject).toBe(header.subject);
    expect(fetched.attachments).toHaveLength(1);
    expect(fetched.bodyText).toBe("Hello world");
    expect(fetched.bodyHtml).toBe("<p>Hello world</p>");
  });

  it("accepts partial body writes that preserve the other body field", async () => {
    const header = makeHeader({ id: "msg_partial_body" });
    await upsertMessageHeaders(searchClient, header, TEST_INDEX_UID);

    await upsertMessageBody(searchClient, header.id, { bodyText: "plain only" }, TEST_INDEX_UID);
    const afterText = (await getMessageDoc(searchClient, header.id, TEST_INDEX_UID)) as MessageDoc;
    expect(afterText.bodyText).toBe("plain only");
    expect(afterText.bodyHtml).toBeUndefined();

    await upsertMessageBody(
      searchClient,
      header.id,
      { bodyHtml: "<p>html added</p>" },
      TEST_INDEX_UID,
    );
    const afterHtml = (await getMessageDoc(searchClient, header.id, TEST_INDEX_UID)) as MessageDoc;
    expect(afterHtml.bodyText).toBe("plain only");
    expect(afterHtml.bodyHtml).toBe("<p>html added</p>");
  });

  it("deleteMessageDoc returns 0 for an unknown id", async () => {
    const count = await deleteMessageDoc(searchClient, "never_indexed", TEST_INDEX_UID);
    expect(count).toBe(0);
  });

  it("deleteMessageDoc returns 1 and removes the doc for a known id", async () => {
    const header = makeHeader({ id: "msg_delete" });
    await upsertMessageHeaders(searchClient, header, TEST_INDEX_UID);

    const count = await deleteMessageDoc(searchClient, header.id, TEST_INDEX_UID);
    expect(count).toBe(1);
    expect(await getMessageDoc(searchClient, header.id, TEST_INDEX_UID)).toBeNull();
  });

  it("upsertMessageAttachments with an empty array clears the existing list", async () => {
    // Reparse scenario: a message's attachment list shrinks to zero. The
    // partial upsert must replace the prior list (not be a no-op), so the
    // doc ends with an explicit empty array rather than the stale set.
    const header = makeHeader({ id: "msg_reparse" });
    await upsertMessageHeaders(searchClient, header, TEST_INDEX_UID);
    await upsertMessageAttachments(
      searchClient,
      header.id,
      [{ filename: "first.pdf", mimeType: "application/pdf", size: 100 }],
      TEST_INDEX_UID,
    );

    await upsertMessageAttachments(searchClient, header.id, [], TEST_INDEX_UID);

    const fetched = (await getMessageDoc(searchClient, header.id, TEST_INDEX_UID)) as MessageDoc;
    expect(fetched.attachments).toEqual([]);
  });

  it("partial upserts against a missing id create an orphan unreachable by emailAccountId filter", async () => {
    // Pins the documented hazard on `upsertMessageBody` (and
    // `upsertMessageAttachments`): Meilisearch's updateDocuments creates
    // the doc if missing, leaving only the partial fields set. With no
    // `emailAccountId`, the orphan escapes tenant-scoped cleanup.
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
    await upsertMessageHeaders(
      searchClient,
      makeHeader({ id: "a1", emailAccountId: "acct_A" }),
      TEST_INDEX_UID,
    );
    await upsertMessageHeaders(
      searchClient,
      makeHeader({ id: "a2", emailAccountId: "acct_A" }),
      TEST_INDEX_UID,
    );
    await upsertMessageHeaders(
      searchClient,
      makeHeader({ id: "b1", emailAccountId: "acct_B" }),
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
