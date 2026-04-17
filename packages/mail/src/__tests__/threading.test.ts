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

describe("messageId validation (assertMessageId via buildReplyHeaders)", () => {
  it("accepts contemporary MUA-generated ids without throwing", () => {
    expect(() =>
      buildReplyHeaders({
        messageId: "<123e4567-e89b-12d3-a456-426614174000@nodemailer.com>",
      }),
    ).not.toThrow();
    expect(() =>
      buildReplyHeaders({ messageId: "<CAFoo_Bar+tag=baz@mail.example.co.uk>" }),
    ).not.toThrow();
    // Domain-literal (no-fold-literal per RFC 5322 #3.4.1). Rare but
    // legal; rejecting it would surprise users on direct-IP SMTP servers.
    expect(() => buildReplyHeaders({ messageId: "<a@[192.168.1.1]>" })).not.toThrow();
  });

  it("rejects ids missing the RFC 5322 #3.6.4 shape", () => {
    const cases = [
      "", // falsy guard — programmer bug
      "abc@example.com", // missing brackets
      "<>", // empty content
      "<no-at-sign>", // missing @
      "<@example.com>", // empty id-left
      "<abc@>", // empty id-right
      "<a@b@c>", // multiple @ — ambiguous parse
    ];
    for (const messageId of cases) {
      expect(() => buildReplyHeaders({ messageId })).toThrow("must be angle-bracketed");
    }
  });

  it("rejects whitespace inside the id (header-line breakage / thread-match corruption)", () => {
    // CR/LF = header-line injection into intermediate strings
    // (References chains built here propagate to DB, UI, logs before
    // nodemailer's output sanitization). Space/TAB = nodemailer silently
    // strips internal whitespace in References/In-Reply-To, so accepting
    // "<a b@c>" would produce "<ab@c>" on the wire and misdirect the
    // recipient's thread-match.
    const inputs = [
      "<evil\r\nBcc: attacker@x>", // CRLF (most dangerous)
      "<a\tb@c>", // TAB
      "<a b@c>", // space in id-left
      "<a@b c>", // space in id-right
    ];
    for (const messageId of inputs) {
      expect(() => buildReplyHeaders({ messageId })).toThrow("must be angle-bracketed");
    }
  });

  it("validation runs from buildForwardHeaders too (not just reply)", () => {
    // Guards against someone stripping assertMessageId from one entry point.
    expect(() => buildForwardHeaders({ messageId: "<evil\r\nX: y@h>" })).toThrow(
      "must be angle-bracketed",
    );
  });
});
