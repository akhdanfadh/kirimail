import type { MessageStructureObject } from "imapflow";

import { describe, expect, it } from "vitest";

import { parseAttachments } from "../parser";

// ---------------------------------------------------------------------------
// Fixture builders - match imapflow's MessageStructureObject shape literally
// so tests stay decoupled from the walker's internal traversal.
// ---------------------------------------------------------------------------

function textPlain(overrides: Partial<MessageStructureObject> = {}): MessageStructureObject {
  return { part: "1", type: "text/plain", size: 100, ...overrides };
}

function textHtml(overrides: Partial<MessageStructureObject> = {}): MessageStructureObject {
  return { part: "1", type: "text/html", size: 200, ...overrides };
}

function multipartAlternative(
  children: MessageStructureObject[],
  overrides: Partial<MessageStructureObject> = {},
): MessageStructureObject {
  return { type: "multipart/alternative", childNodes: children, ...overrides };
}

function multipartMixed(
  children: MessageStructureObject[],
  overrides: Partial<MessageStructureObject> = {},
): MessageStructureObject {
  return { type: "multipart/mixed", childNodes: children, ...overrides };
}

function multipartRelated(
  children: MessageStructureObject[],
  overrides: Partial<MessageStructureObject> = {},
): MessageStructureObject {
  return { type: "multipart/related", childNodes: children, ...overrides };
}

function multipartSigned(
  children: MessageStructureObject[],
  overrides: Partial<MessageStructureObject> = {},
): MessageStructureObject {
  return { type: "multipart/signed", childNodes: children, ...overrides };
}

function multipartEncrypted(
  children: MessageStructureObject[],
  overrides: Partial<MessageStructureObject> = {},
): MessageStructureObject {
  return { type: "multipart/encrypted", childNodes: children, ...overrides };
}

function multipartReport(
  children: MessageStructureObject[],
  overrides: Partial<MessageStructureObject> = {},
): MessageStructureObject {
  return { type: "multipart/report", childNodes: children, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseAttachments", () => {
  it("returns empty array for undefined input", () => {
    expect(parseAttachments(undefined)).toEqual([]);
  });

  it("returns empty array for a text-only root (no multipart wrapper)", () => {
    expect(parseAttachments(textPlain())).toEqual([]);
  });

  it("skips text/plain and text/html body parts inside multipart/alternative", () => {
    const tree = multipartAlternative([textPlain(), textHtml()]);
    expect(parseAttachments(tree)).toEqual([]);
  });

  it("emits one entry for multipart/mixed with a single application/pdf attachment", () => {
    const tree = multipartMixed([
      textPlain(),
      {
        part: "2",
        type: "application/pdf",
        size: 54321,
        disposition: "attachment",
        dispositionParameters: { filename: "report.pdf" },
      },
    ]);

    expect(parseAttachments(tree)).toEqual([
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 54321,
        contentId: null,
        disposition: "attachment",
        partPath: "2",
      },
    ]);
  });

  it("emits an inline image inside multipart/related with contentId and disposition", () => {
    const tree = multipartRelated([
      multipartAlternative([textPlain(), textHtml()]),
      {
        part: "2",
        type: "image/png",
        size: 9876,
        id: "logo@example.com",
        disposition: "inline",
        dispositionParameters: { filename: "logo.png" },
      },
    ]);

    expect(parseAttachments(tree)).toEqual([
      {
        filename: "logo.png",
        mimeType: "image/png",
        size: 9876,
        contentId: "logo@example.com",
        disposition: "inline",
        partPath: "2",
      },
    ]);
  });

  it("emits a text leaf when Content-Disposition is attachment (EmailEngine rule)", () => {
    const tree = multipartMixed([
      textPlain(),
      textPlain({
        part: "2",
        size: 42,
        disposition: "attachment",
        dispositionParameters: { filename: "notes.txt" },
      }),
    ]);

    expect(parseAttachments(tree)).toEqual([
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        size: 42,
        contentId: null,
        disposition: "attachment",
        partPath: "2",
      },
    ]);
  });

  it("keeps a text leaf with Content-Type name but no disposition as a body part", () => {
    // Reflects EmailEngine's intent: filename presence alone is not enough
    // to reclassify a text part; disposition is the discriminator.
    const tree = multipartAlternative([
      textPlain(),
      textHtml({ parameters: { name: "styled-body" } }),
    ]);
    expect(parseAttachments(tree)).toEqual([]);
  });

  it("falls back to Content-Type name when Content-Disposition has no filename", () => {
    const tree = multipartMixed([
      textPlain(),
      {
        part: "2",
        type: "application/zip",
        size: 1234,
        parameters: { name: "bundle.zip" },
      },
    ]);

    expect(parseAttachments(tree)[0]?.filename).toBe("bundle.zip");
  });

  it("emits filename null when neither disposition nor type parameter carries a name", () => {
    const tree = multipartMixed([
      textPlain(),
      { part: "2", type: "application/octet-stream", size: 10 },
    ]);

    expect(parseAttachments(tree)[0]).toEqual({
      filename: null,
      mimeType: "application/octet-stream",
      size: 10,
      contentId: null,
      disposition: null,
      partPath: "2",
    });
  });

  it("emits null size when the server omits the per-part octet count", () => {
    const tree = multipartMixed([
      textPlain(),
      {
        part: "2",
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "x.pdf" },
      },
    ]);

    expect(parseAttachments(tree)[0]?.size).toBeNull();
  });

  it("recurses through nested multipart containers", () => {
    const tree = multipartMixed([
      multipartAlternative([textPlain(), textHtml()]),
      {
        part: "2",
        type: "application/pdf",
        size: 1,
        disposition: "attachment",
        dispositionParameters: { filename: "deep.pdf" },
      },
    ]);

    const result = parseAttachments(tree);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("deep.pdf");
  });

  it("emits the rfc822 wrapper AND recurses into its children with distinct partPaths", () => {
    const innerPdf: MessageStructureObject = {
      part: "2.2",
      type: "application/pdf",
      size: 500,
      disposition: "attachment",
      dispositionParameters: { filename: "inside.pdf" },
    };
    const innerBody = multipartMixed([{ part: "2.1", type: "text/plain", size: 10 }, innerPdf], {
      part: "2",
    });

    const rfc822: MessageStructureObject = {
      part: "2",
      type: "message/rfc822",
      size: 1000,
      childNodes: [innerBody],
    };

    const tree = multipartMixed([textPlain(), rfc822]);

    const result = parseAttachments(tree);
    expect(result).toHaveLength(2);

    const [wrapper, inner] = result;
    expect(wrapper).toMatchObject({
      mimeType: "message/rfc822",
      filename: null,
      partPath: "2",
    });
    expect(inner).toMatchObject({
      filename: "inside.pdf",
      mimeType: "application/pdf",
      partPath: "2.2",
    });
  });

  it("skips the signature child of multipart/signed but emits siblings of the signed container", () => {
    // Real-world shape: a PGP-signed message containing a PDF attachment.
    // The signature is protocol machinery; the PDF (living beside the
    // signed container, not inside it) is a legitimate attachment.
    const tree = multipartMixed([
      multipartSigned([
        multipartAlternative([textPlain(), textHtml()]),
        {
          part: "1.2",
          type: "application/pgp-signature",
          size: 512,
          parameters: { name: "signature.asc" },
        },
      ]),
      {
        part: "2",
        type: "application/pdf",
        size: 9999,
        disposition: "attachment",
        dispositionParameters: { filename: "real.pdf" },
      },
    ]);

    const result = parseAttachments(tree);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("real.pdf");
  });

  it("skips pkcs7 and x-pkcs7 signatures inside multipart/signed", () => {
    const pkcs7 = multipartSigned([
      textPlain(),
      { part: "1.2", type: "application/pkcs7-signature", size: 1 },
    ]);
    const xPkcs7 = multipartSigned([
      textPlain(),
      { part: "1.2", type: "application/x-pkcs7-signature", size: 1 },
    ]);

    expect(parseAttachments(pkcs7)).toEqual([]);
    expect(parseAttachments(xPkcs7)).toEqual([]);
  });

  it("skips both children of multipart/encrypted", () => {
    const tree = multipartEncrypted([
      { part: "1", type: "application/pgp-encrypted", size: 11 },
      { part: "2", type: "application/octet-stream", size: 5000 },
    ]);

    expect(parseAttachments(tree)).toEqual([]);
  });

  it("skips delivery-status, rfc822-headers, and the bounced rfc822 inside multipart/report", () => {
    // The bounced-original message/rfc822 is protocol too - users see a
    // bounce notification, not "attachments of the bounce." Filtering
    // the wrapper also skips its children via the protocol-subtree skip.
    const innerBouncedPdf: MessageStructureObject = {
      part: "3.2",
      type: "application/pdf",
      size: 100,
      disposition: "attachment",
      dispositionParameters: { filename: "never-delivered.pdf" },
    };
    const bouncedOriginal: MessageStructureObject = {
      part: "3",
      type: "message/rfc822",
      size: 500,
      childNodes: [
        multipartMixed([{ part: "3.1", type: "text/plain", size: 10 }, innerBouncedPdf], {
          part: "3",
        }),
      ],
    };
    const tree = multipartReport([
      textPlain(),
      { part: "2", type: "message/delivery-status", size: 200 },
      bouncedOriginal,
    ]);

    expect(parseAttachments(tree)).toEqual([]);
  });

  it("treats text/* leaves under multipart/alternative as body parts", () => {
    // Meeting invites: multipart/alternative of [text/plain, text/html,
    // text/calendar] - the .ics is a rendering alternative, not a
    // standalone file. No phantom invite chip on every invite received.
    const tree = multipartAlternative([
      textPlain(),
      textHtml(),
      { part: "3", type: "text/calendar", size: 300, parameters: { method: "REQUEST" } },
    ]);

    expect(parseAttachments(tree)).toEqual([]);
  });

  it("emits a text/* leaf outside multipart/alternative as an attachment", () => {
    // Standalone calendar attached alongside a body - the parent is
    // multipart/mixed, so the .ics is a real file, not an alternative.
    const tree = multipartMixed([
      multipartAlternative([textPlain(), textHtml()]),
      {
        part: "2",
        type: "text/calendar",
        size: 500,
        disposition: "attachment",
        dispositionParameters: { filename: "meeting.ics" },
      },
    ]);

    const result = parseAttachments(tree);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("meeting.ics");
  });

  it("emits a protocol-typed leaf when it sits outside its protocol container", () => {
    // A user literally attaching a .p7s cert file under multipart/mixed
    // is not protocol machinery - the parent-type gate is what makes the
    // filter precise.
    const tree = multipartMixed([
      textPlain(),
      {
        part: "2",
        type: "application/pgp-signature",
        size: 1000,
        disposition: "attachment",
        dispositionParameters: { filename: "mykey.asc" },
      },
    ]);

    const result = parseAttachments(tree);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("mykey.asc");
  });

  it("strips angle brackets around Content-ID values", () => {
    const tree = multipartRelated([
      textHtml(),
      {
        part: "2",
        type: "image/png",
        size: 1,
        id: "<abc@example.com>",
        disposition: "inline",
      },
    ]);

    expect(parseAttachments(tree)[0]?.contentId).toBe("abc@example.com");
  });

  it("treats whitespace-only or empty Content-ID as null", () => {
    const tree = multipartMixed([
      textPlain(),
      {
        part: "2",
        type: "image/png",
        size: 1,
        id: "   ",
      },
    ]);

    expect(parseAttachments(tree)[0]?.contentId).toBeNull();
  });

  it("classifies correctly when the server returns uppercase type and disposition", () => {
    // Defense against imapflow's lowercasing invariant ever drifting:
    // multipart detection, body-vs-attachment, and the emitted mimeType
    // all rely on lowercase comparison. A non-conforming server must
    // not break classification.
    const tree: MessageStructureObject = {
      type: "MULTIPART/MIXED",
      childNodes: [
        { part: "1", type: "TEXT/PLAIN", size: 1 },
        {
          part: "2",
          type: "APPLICATION/PDF",
          size: 10,
          disposition: "ATTACHMENT",
          dispositionParameters: { filename: "x.pdf" },
        },
      ],
    };

    const result = parseAttachments(tree);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      mimeType: "application/pdf",
      disposition: "attachment",
      filename: "x.pdf",
    });
  });

  it('defaults partPath to "1" when the whole message is a bare attachment', () => {
    // imapflow omits `part` at the tree root; IMAP addresses a single-
    // part body as BODY[1], so the walker synthesizes "1". Every other
    // test sets `part` explicitly, so only this one exercises the
    // fallback.
    const tree: MessageStructureObject = {
      type: "application/pdf",
      size: 42,
      disposition: "attachment",
      dispositionParameters: { filename: "just-a-pdf.pdf" },
    };

    expect(parseAttachments(tree)).toEqual([
      {
        filename: "just-a-pdf.pdf",
        mimeType: "application/pdf",
        size: 42,
        contentId: null,
        disposition: "attachment",
        partPath: "1",
      },
    ]);
  });

  it("narrows unknown disposition values to null", () => {
    const tree = multipartMixed([
      textPlain(),
      {
        part: "2",
        type: "application/pdf",
        size: 10,
        // A server returning a non-standard disposition must not leak the raw
        // string into our type - narrowDisposition maps it to null.
        disposition: "form-data",
        dispositionParameters: { filename: "weird.pdf" },
      },
    ]);

    expect(parseAttachments(tree)[0]?.disposition).toBeNull();
  });
});
