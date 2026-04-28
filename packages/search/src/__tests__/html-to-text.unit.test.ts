import { describe, expect, it } from "vitest";

import { htmlToPlainText } from "../html-to-text";

describe("htmlToPlainText", () => {
  it("returns undefined for empty input so partial-merge upserts skip it", () => {
    // The partial-merge contract on Meilisearch's `updateDocuments` writes
    // every key in the payload. If this returned an empty string, the doc
    // would gain `bodyTextDerived: ""` instead of leaving it absent.
    expect(htmlToPlainText("")).toBeUndefined();
  });

  it("returns undefined when stripping leaves only whitespace", () => {
    // After skipping `<img>`, image-only HTML reduces to surrounding
    // whitespace. Returning undefined (instead of "") lets the worker's
    // all-undefined branch short-circuit cleanly.
    expect(htmlToPlainText('<p><img src="cid:x"></p>')).toBeUndefined();
    expect(htmlToPlainText("   \n\t  ")).toBeUndefined();
  });

  it("strips script and style content from the indexed output", () => {
    // Default html-to-text formatter for unknown elements is `inline`, so
    // without our `format: 'skip'` selectors the inner text of <script> and
    // <style> would land in the search index. A dependency upgrade that
    // changed default behavior would surface here.
    const html = `
      <p>visible</p>
      <script>const payload = "scriptToken";</script>
      <style>.x { color: red; /* styleToken */ }</style>
    `;
    const out = htmlToPlainText(html)!;
    expect(out).toContain("visible");
    expect(out).not.toContain("scriptToken");
    expect(out).not.toContain("styleToken");
  });

  it("strips img src URLs (cid: / tracking pixels) from the indexed output", () => {
    // Default `image` formatter emits the src URL. Email images are commonly
    // `cid:` references or tracking pixels - both are noise in a token index.
    const html =
      '<p>Hello</p><img src="cid:tracking@example"><img src="https://t.example/pixel.gif">';
    const out = htmlToPlainText(html)!;
    expect(out).toContain("Hello");
    expect(out).not.toContain("cid:tracking");
    expect(out).not.toContain("pixel.gif");
  });

  it("does not insert wordwrap newlines mid-content", () => {
    // html-to-text's default `wordwrap: 80` would inject newlines into a
    // long token-rich string, fragmenting Meilisearch's tokenization.
    // Our `wordwrap: false` keeps the line intact. Asserting the contract
    // ("no newlines") rather than exact equality avoids fragility against
    // future formatter changes (paragraph spacing, leading bullets, etc.)
    // that don't affect tokenization.
    const long = "alpha ".repeat(40).trim();
    const out = htmlToPlainText(`<p>${long}</p>`)!;
    expect(out).toContain(long);
    expect(out).not.toMatch(/\n/);
  });
});
