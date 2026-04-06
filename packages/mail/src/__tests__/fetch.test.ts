import { describe, expect, it } from "vitest";

import { parseHeaderValue } from "../fetch";

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
