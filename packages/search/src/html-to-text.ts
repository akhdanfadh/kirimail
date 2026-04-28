import { compile } from "html-to-text";

// Module-level compile() so options are parsed once; callers invoke the
// compiled converter per message. Matches html-to-text's hot-path pattern
// (EmailEngine `lib/generate-text-preview.js`).
//
// Defaults kept on purpose: `decodeEntities: true` for unicode tokens, and the
// default anchor formatter emits `text [href]` so bracketed URLs add searchable
// URL tokens (occasional value for "find the email containing that link").
const compiledConvert = compile({
  // Line wrapping is for human reading; in the index it just fragments tokens.
  wordwrap: false,
  selectors: [
    // Default for unknown elements is `inline`, which would emit `<script>`
    // and `<style>` source as searchable tokens. We want neither in the index.
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    // Default `image` formatter emits the `src` URL. For email that's usually
    // a `cid:` reference or a tracking pixel - both are pure index junk.
    // Tradeoff: alt text drops out too, but its search value is marginal.
    { selector: "img", format: "skip" },
  ],
});

/**
 * Convert HTML to a plain-text projection for full-text indexing.
 * Returns `undefined` for empty / whitespace-only input or output, so callers
 * using partial-merge upserts don't accidentally write empty strings.
 */
export function htmlToPlainText(html: string): string | undefined {
  const out = compiledConvert(html).trim();
  return out.length === 0 ? undefined : out;
}
