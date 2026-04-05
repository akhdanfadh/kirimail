import { describe, expect, it } from "vitest";

import type { SyncCursor } from "../types";

import { compareSyncCursors } from "../sync-cursor";

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
