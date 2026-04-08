import type { SyncCursor } from "@kirimail/shared";

import { describe, expect, it } from "vitest";

import { compareSyncCursors, parseHeaderValue } from "../sync";

const baseCursor: SyncCursor = {
  uidValidity: 1,
  uidNext: 10,
  highestModseq: null,
  messageCount: 20,
};

describe("compareSyncCursors", () => {
  it("returns full-resync when no prior cursor exists", () => {
    expect(compareSyncCursors(null, baseCursor)).toEqual({
      type: "full-resync",
      reason: "no-prior-cursor",
    });
  });

  it("returns full-resync when uidValidity changed", () => {
    const stored = { ...baseCursor };
    const current = { ...baseCursor, uidValidity: 2 };

    expect(compareSyncCursors(stored, current)).toEqual({
      type: "full-resync",
      reason: "uid-validity-changed",
    });
  });

  it("returns incremental with additionsOnly when balanced", () => {
    const stored = { ...baseCursor };
    // 5 new UIDs, 5 new messages - only additions
    const current = { ...baseCursor, uidNext: 15, messageCount: 25 };

    expect(compareSyncCursors(stored, current)).toEqual({
      type: "incremental",
      newMessages: true,
      flagChanges: false,
      additionsOnly: true,
    });
  });

  it("returns additionsOnly false when unbalanced (deletions happened)", () => {
    const stored = { ...baseCursor };
    // 5 new UIDs but only 2 more messages - 3 were deleted
    const current = { ...baseCursor, uidNext: 15, messageCount: 22 };

    expect(compareSyncCursors(stored, current)).toEqual({
      type: "incremental",
      newMessages: true,
      flagChanges: false,
      additionsOnly: false,
    });
  });

  it("detects pure deletion without new messages", () => {
    const stored = { ...baseCursor };
    // same uidNext but fewer messages - emails were deleted
    const current = { ...baseCursor, messageCount: 18 };

    expect(compareSyncCursors(stored, current)).toEqual({
      type: "incremental",
      newMessages: false,
      flagChanges: false,
      additionsOnly: false,
    });
  });

  it("returns flagChanges when highestModseq increased", () => {
    const stored = { ...baseCursor, highestModseq: 5 };
    const current = { ...baseCursor, highestModseq: 8 };

    expect(compareSyncCursors(stored, current)).toEqual({
      type: "incremental",
      newMessages: false,
      flagChanges: true,
      additionsOnly: true,
    });
  });

  it("returns noop when nothing changed", () => {
    expect(compareSyncCursors(baseCursor, { ...baseCursor })).toEqual({
      type: "noop",
    });
  });
});

describe("parseHeaderValue", () => {
  it("extracts a single-line header value", () => {
    const buf = Buffer.from("References: <msg-001@example.com>\r\n");
    expect(parseHeaderValue(buf, "references")).toBe("<msg-001@example.com>");
  });

  it("unfolds a multi-line (folded) header", () => {
    // A 6-reply thread: References folds across 3 lines at ~78 chars each
    const buf = Buffer.from(
      "References: <msg-001@example.com> <msg-002@example.com>\r\n" +
        "\t<msg-003@example.com> <msg-004@example.com>\r\n" +
        "\t<msg-005@example.com> <msg-006@example.com>\r\n",
    );
    expect(parseHeaderValue(buf, "references")).toBe(
      "<msg-001@example.com> <msg-002@example.com> " +
        "<msg-003@example.com> <msg-004@example.com> " +
        "<msg-005@example.com> <msg-006@example.com>",
    );
  });

  it("unfolds with LF-only line endings (no CR)", () => {
    // Some servers or proxies strip \r, leaving bare \n
    const buf = Buffer.from("References: <msg-001@example.com>\n\t<msg-002@example.com>\n");
    expect(parseHeaderValue(buf, "references")).toBe("<msg-001@example.com> <msg-002@example.com>");
  });

  it("matches header name case-insensitively", () => {
    // IMAP servers vary: Stalwart sends "References:", others may send "REFERENCES:"
    const buf = Buffer.from("REFERENCES: <msg-001@example.com>\r\n");
    expect(parseHeaderValue(buf, "references")).toBe("<msg-001@example.com>");
  });

  it("returns null for empty buffer", () => {
    expect(parseHeaderValue(Buffer.alloc(0), "references")).toBeNull();
  });

  it("returns null for undefined buffer", () => {
    expect(parseHeaderValue(undefined, "references")).toBeNull();
  });

  it("returns null when requested header is absent from buffer", () => {
    const buf = Buffer.from("Subject: hello world\r\n");
    expect(parseHeaderValue(buf, "references")).toBeNull();
  });
});
