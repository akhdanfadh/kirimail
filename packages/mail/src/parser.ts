import type { AttachmentMetadata } from "@kirimail/shared";
import type { MessageStructureObject } from "imapflow";

/**
 * Flatten IMAP BODYSTRUCTURE tree into attachment metadata. Returns `[]` when
 * the server omits BODYSTRUCTURE or no leaf qualifies as an attachment.
 * See {@link walk} for the emission reasoning.
 *
 * @see https://www.rfc-editor.org/rfc/rfc3501#section-7.4.2 - BODYSTRUCTURE grammar
 */
export function parseAttachments(root: MessageStructureObject | undefined): AttachmentMetadata[] {
  if (!root) return [];
  const attachments: AttachmentMetadata[] = [];
  walk(root, null, attachments);
  return attachments;
}

/**
 * Recursive traversal for classifying MIME leaf as an attachment.
 *
 * @param node Current BODYSTRUCTURE node being visited.
 * @param parentType MIME type of the direct parent, or null at the root.
 * @param out Accumulator for emitted attachments, mutated in place.
 */
function walk(
  node: MessageStructureObject,
  parentType: string | null,
  out: AttachmentMetadata[],
): void {
  // Normalize once so comparisons don't depend on imapflow's casing invariant.
  const type = node.type.toLowerCase();
  const disposition = node.disposition?.toLowerCase();

  // "multipart/*" nodes are grouping-only; they carry no content to attach.
  // Every real attachment sits at a leaf under one of these.
  const isMultipart = type.startsWith("multipart/");

  // Protocol-structural parts serve MIME wrapping, not user content -
  // skip emission AND recursion so signed/encrypted/report subtrees stay
  // opaque from our UX vantage.
  if (!isMultipart && isProtocolPart(type, parentType)) return;

  if (!isMultipart) {
    // text/plain and text/html are body. Any text/* directly under multipart/alternative
    // is also body - covers meeting invites arriving as alternative -> [text/plain, text/html, text/calendar]
    // where `.ics` is a rendering, not a file. Elsewhere, text/* is a standalone file.
    // Explicit `attachment` disposition always overrides.
    //
    // Filename presence is deliberately NOT a reclassification signal for text/*:
    // multipart/alternative bodies legitimately carry `Content-Type; name=` parameters
    // (stylesheet labels, readability hints) that don't mean "attachment."
    // Consequence: a .txt attached with only `Content-Type; name=` and no
    // `Content-Disposition` is invisible. EmailEngine's production-battle-tested rule.
    //
    // Non-text leaves always emit, inline HTML-embedded images included.
    // Splitting "real attachment" from "inline embed" needs the HTML
    // body to resolve `cid:` references - not available at sync time.
    // The search dispatcher owns that partition via disposition + contentId.
    const isBodyText =
      type === "text/plain" ||
      type === "text/html" ||
      (parentType === "multipart/alternative" && type.startsWith("text/"));
    const isAttachment = disposition === "attachment" || !isBodyText;
    if (isAttachment) {
      out.push({
        // RFC 2183 `Content-Disposition; filename=` is authoritative;
        // `Content-Type; name=` is the pre-2183 legacy fallback.
        filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? null,
        mimeType: type,
        // Null (not 0) when the server omits size, so UI can show
        // "unknown" rather than a misleading "0 B".
        size: node.size ?? null,
        contentId: normalizeContentId(node.id),
        // Collapse non-standard disposition tokens (e.g. `form-data`)
        // to null rather than leaking raw strings through the type.
        disposition: disposition === "attachment" || disposition === "inline" ? disposition : null,
        // imapflow omits `part` at the tree root; IMAP addresses the
        // whole body as `BODY[1]` for single-part messages.
        partPath: node.part ?? "1",
      });
    }
  }

  // message/rfc822 is both a leaf (self-contained `.eml` with a size) and a container.
  // Emit the wrapper AND recurse so search indexes both the forward chip and its
  // inner attachments; consumers filter out descendants of any emitted rfc822
  // when counting "attachments the human sees."
  if (node.childNodes) {
    for (const child of node.childNodes) {
      walk(child, type, out);
    }
  }
}

/**
 * True when a leaf is MIME-protocol machinery rather than user content,
 * based on the direct parent container:
 *
 * - `multipart/signed` (RFC 1847): detached signature (pgp / pkcs7 / x-pkcs7).
 *   The signed content falls through.
 * - `multipart/encrypted` (RFC 1847): both children - the pgp-encrypted control part
 *   and the opaque octet-stream blob. Users see "encrypted message," not two attachments.
 * - `multipart/report` (RFC 3462): delivery-status, rfc822-headers, and
 *   the bounced `message/rfc822` original. The human-readable text falls through.
 *
 * The parent-type gate is load-bearing: a user attaching a `.p7s` file
 * under `multipart/mixed` is NOT filtered.
 *
 * NOTE: Filter is by type only, not child position. A pathological `multipart/signed`
 * with the signature as the first child would lose its real content -
 * accepted as an RFC violation not worth tracking child-index state for.
 */
function isProtocolPart(type: string, parentType: string | null): boolean {
  if (parentType === "multipart/signed") {
    return (
      type === "application/pgp-signature" ||
      type === "application/pkcs7-signature" ||
      type === "application/x-pkcs7-signature"
    );
  }
  if (parentType === "multipart/encrypted") {
    return type === "application/pgp-encrypted" || type === "application/octet-stream";
  }
  if (parentType === "multipart/report") {
    return (
      type === "message/delivery-status" ||
      type === "text/rfc822-headers" ||
      type === "message/rfc822"
    );
  }
  return false;
}

/**
 * Strip surrounding angle brackets from a Content-ID so downstream `cid:` URL rewriting
 * can concatenate the bare form. Stripping is all-or-nothing - a one-sided value passes
 * through verbatim so a malformed header can't silently lookalike-match a real part;
 * the resulting `cid:` URL simply misses, which is the correct failure.
 */
function normalizeContentId(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const stripped =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  return stripped.length === 0 ? null : stripped;
}
