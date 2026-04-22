import { describe, expect, it } from "vitest";

import { isDescendantPart } from "../message";

describe("isDescendantPart", () => {
  it("accepts dot-separated descendants", () => {
    expect(isDescendantPart("2.1", "2")).toBe(true);
    expect(isDescendantPart("2.1.3", "2.1")).toBe(true);
  });

  it("rejects paths that only share a numeric prefix at a segment boundary", () => {
    // The footgun the helper exists to prevent: a raw `startsWith`
    // would false-positive on these.
    expect(isDescendantPart("21", "2")).toBe(false);
    expect(isDescendantPart("210", "21")).toBe(false);
    expect(isDescendantPart("2.10.3", "2.1")).toBe(false);
  });

  it("rejects same path and reversed arguments", () => {
    expect(isDescendantPart("2", "2")).toBe(false);
    expect(isDescendantPart("2", "2.1")).toBe(false);
  });
});
