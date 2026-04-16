import { describe, expect, it } from "vitest";

import { buildForwardHeaders, buildReplyHeaders } from "../threading";

describe("buildReplyHeaders", () => {
  it("starts a new chain when the referenced message has no references", () => {
    const result = buildReplyHeaders({
      messageId: "<abc@example.com>",
    });

    expect(result).toEqual({
      inReplyTo: "<abc@example.com>",
      references: "<abc@example.com>",
    });
  });

  it("appends to an existing references chain", () => {
    const result = buildReplyHeaders({
      messageId: "<c@example.com>",
      references: "<a@example.com> <b@example.com>",
    });

    expect(result).toEqual({
      inReplyTo: "<c@example.com>",
      references: "<a@example.com> <b@example.com> <c@example.com>",
    });
  });
});

describe("buildForwardHeaders", () => {
  it("starts a new chain when the referenced message has no references", () => {
    const result = buildForwardHeaders({
      messageId: "<orig@example.com>",
    });

    expect(result).toEqual({
      references: "<orig@example.com>",
    });
  });

  it("appends to an existing references chain", () => {
    const result = buildForwardHeaders({
      messageId: "<b@example.com>",
      references: "<a@example.com>",
    });

    expect(result).toEqual({
      references: "<a@example.com> <b@example.com>",
    });
  });
});

describe("messageId validation", () => {
  it("rejects a messageId without angle brackets", () => {
    expect(() => buildReplyHeaders({ messageId: "abc@example.com" })).toThrow(
      "must be angle-bracketed",
    );
  });

  it("rejects an empty messageId", () => {
    expect(() => buildReplyHeaders({ messageId: "" })).toThrow("must be angle-bracketed");
  });

  it("rejects empty angle brackets", () => {
    expect(() => buildReplyHeaders({ messageId: "<>" })).toThrow("must be angle-bracketed");
  });

  it("rejects in buildForwardHeaders too", () => {
    expect(() => buildForwardHeaders({ messageId: "no-brackets@example.com" })).toThrow(
      "must be angle-bracketed",
    );
  });
});
