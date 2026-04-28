import { beforeAll, describe, expect, it } from "vitest";

import { searchClient } from "../client";
import { ensureMeilisearchConfig } from "../config";
import { awaitTaskOrThrow } from "../tasks";
import { TEST_INDEX_UID } from "./helpers";

describe("ensureMeilisearchConfig", () => {
  beforeAll(async () => {
    await ensureMeilisearchConfig(searchClient, TEST_INDEX_UID);
  });

  it("creates the index with the locked primary key", async () => {
    const info = await searchClient.index(TEST_INDEX_UID).getRawInfo();
    expect(info.uid).toBe(TEST_INDEX_UID);
    expect(info.primaryKey).toBe("id");
  });

  it("applies the canonical attribute settings", async () => {
    const settings = await searchClient.index(TEST_INDEX_UID).getSettings();
    // searchableAttributes order pinned: Meilisearch ranking is positional,
    // so a reorder here is a real behavior change.
    expect(settings.searchableAttributes).toEqual([
      "subject",
      "from",
      "to",
      "cc",
      "bcc",
      "attachments.filename",
      "bodyText",
      "bodyTextDerived",
    ]);
    // filterableAttributes / displayedAttributes order doesn't affect runtime
    // behavior, so set equality avoids failing on harmless reorders for
    // readability. Pin that bodyTextDerived is excluded from displayedAttributes -
    // the search-only contract that keeps the synthesized text out of search
    // responses and `_formatted` snippets.
    expect(new Set(settings.filterableAttributes)).toEqual(
      new Set([
        "userId",
        "emailAccountId",
        "mailboxId",
        "receivedDate",
        "sizeBytes",
        "flags",
        "encrypted",
      ]),
    );
    expect(settings.sortableAttributes).toEqual(["receivedDate", "sizeBytes"]);
    expect(new Set(settings.displayedAttributes)).toEqual(
      new Set([
        "id",
        "userId",
        "emailAccountId",
        "mailboxId",
        "subject",
        "from",
        "to",
        "cc",
        "bcc",
        "receivedDate",
        "sizeBytes",
        "flags",
        "encrypted",
        "attachments",
        "bodyText",
        "bodyHtml",
      ]),
    );
  });

  it("restores canonical settings if they drift between boots", async () => {
    // Mutate sortableAttributes out from under us, then re-run ensure.
    // ensureMeilisearchConfig must re-apply settings even when the index
    // already exists - guards against a future "skip if configured"
    // optimization that would silently let prod settings drift.
    await awaitTaskOrThrow(
      "drift-bait updateSettings",
      searchClient.index(TEST_INDEX_UID).updateSettings({ sortableAttributes: ["sizeBytes"] }),
    );

    await ensureMeilisearchConfig(searchClient, TEST_INDEX_UID);

    const settings = await searchClient.index(TEST_INDEX_UID).getSettings();
    expect(settings.sortableAttributes).toEqual(["receivedDate", "sizeBytes"]);
  });

  it("rejects a preexisting index whose primary key doesn't match", async () => {
    // Cover the index_already_exists branch's primary-key sanity check
    // (config.ts's defensive guard for bad migrations or operator-restored
    // snapshots configured with a different key).
    const foreignUid = `${TEST_INDEX_UID}_foreign`;
    await awaitTaskOrThrow(
      "seed foreign createIndex",
      searchClient.createIndex(foreignUid, { primaryKey: "uid" }),
    );

    await expect(ensureMeilisearchConfig(searchClient, foreignUid)).rejects.toThrow(
      /primaryKey="id", got uid/,
    );
  });
});
