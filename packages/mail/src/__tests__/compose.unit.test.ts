import type { MessageAddress } from "@kirimail/shared";

import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";

import { buildRawMessage, stripBcc } from "../compose";

const parse = (raw: Buffer) => PostalMime.parse(raw);

const alice: MessageAddress = { name: "Alice", address: "alice@example.com" };
const bob: MessageAddress = { name: null, address: "bob@example.com" };
const carol: MessageAddress = { name: "Carol", address: "carol@example.com" };

describe("buildRawMessage", () => {
  it("produces valid MIME with correct headers for a text-only message", async () => {
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      subject: "Hello",
      text: "Hi Bob",
    });

    const parsed = await parse(result.raw);

    expect(parsed.from?.address).toBe("alice@example.com");
    expect(parsed.to?.[0]?.address).toBe("bob@example.com");
    expect(parsed.subject).toBe("Hello");
    expect(parsed.text?.trim()).toBe("Hi Bob");
    expect(parsed.messageId).toBe(result.messageId);
    expect(parsed.date).toBeDefined();
  });

  it("produces multipart/alternative for html + text", async () => {
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      subject: "Rich",
      text: "plain",
      html: "<p>rich</p>",
    });

    const parsed = await parse(result.raw);

    expect(parsed.text?.trim()).toBe("plain");
    expect(parsed.html).toContain("<p>rich</p>");
  });

  it("includes In-Reply-To and References headers", async () => {
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      subject: "Re: Thread",
      text: "reply",
      inReplyTo: "<parent@example.com>",
      references: "<root@example.com> <parent@example.com>",
    });

    const parsed = await parse(result.raw);

    expect(parsed.inReplyTo).toBe("<parent@example.com>");
    expect(parsed.references).toContain("<root@example.com>");
    expect(parsed.references).toContain("<parent@example.com>");
  });

  it("includes custom headers in the output", async () => {
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      subject: "Custom",
      text: "test",
      headers: { "X-Mailer": "Kirimail", "X-Request-Id": "abc-123" },
    });

    const parsed = await parse(result.raw);
    expect(parsed.headers.find((h) => h.key === "x-mailer")?.value).toBe("Kirimail");
    expect(parsed.headers.find((h) => h.key === "x-request-id")?.value).toBe("abc-123");
  });

  it("rejects standard header names in custom headers", async () => {
    await expect(
      buildRawMessage({
        from: alice,
        to: [bob],
        subject: "Injection",
        text: "test",
        headers: { From: "evil@attacker.com" },
      }),
    ).rejects.toThrow("must not be passed in custom headers");
  });

  it("rejects standard headers case-insensitively", async () => {
    await expect(
      buildRawMessage({
        from: alice,
        to: [bob],
        subject: "Injection",
        text: "test",
        headers: { "IN-REPLY-TO": "<fake@id>" },
      }),
    ).rejects.toThrow("must not be passed in custom headers");
  });

  it("returns an envelope with all recipients", async () => {
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      cc: [carol],
      bcc: [{ name: "Dave", address: "dave@example.com" }],
      subject: "Envelope",
      text: "test",
    });

    expect(result.envelope.from).toBe("alice@example.com");
    expect(result.envelope.to).toContain("bob@example.com");
    expect(result.envelope.to).toContain("carol@example.com");
    expect(result.envelope.to).toContain("dave@example.com");
  });

  it("filters out null-address MessageAddress entries", async () => {
    const groupSentinel: MessageAddress = { name: "Group", address: null };

    const result = await buildRawMessage({
      from: alice,
      to: [groupSentinel, bob],
      subject: "Filtered",
      text: "test",
    });

    // SMTP envelope must not contain filtered addresses
    expect(result.envelope.to).toEqual(["bob@example.com"]);

    // MIME headers must also reflect filtering
    const parsed = await parse(result.raw);
    const addresses = parsed.to?.map((a) => a.address);
    expect(addresses).toEqual(["bob@example.com"]);
  });

  it("allows bcc-only sends with no to or cc", async () => {
    const result = await buildRawMessage({
      from: alice,
      bcc: [bob],
      subject: "BCC only",
      text: "test",
    });

    expect(result.envelope.to).toContain("bob@example.com");
    const parsed = await parse(result.raw);
    expect(parsed.subject).toBe("BCC only");
  });

  it("throws when no recipients remain after filtering", async () => {
    const groupOnly: MessageAddress = { name: "Group", address: null };

    await expect(
      buildRawMessage({
        from: alice,
        to: [groupOnly],
        subject: "No recipients",
        text: "test",
      }),
    ).rejects.toThrow("At least one recipient with a valid address is required");
  });

  it("sets the Sender header", async () => {
    const result = await buildRawMessage({
      from: alice,
      sender: { name: "Secretary", address: "secretary@example.com" },
      to: [bob],
      subject: "On behalf of",
      text: "test",
    });

    const parsed = await parse(result.raw);
    expect(parsed.sender?.address).toBe("secretary@example.com");
  });

  it("sets a custom Date header", async () => {
    const customDate = new Date("2025-01-15T12:00:00Z");
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      subject: "Backdated",
      text: "test",
      date: customDate,
    });

    const parsed = await parse(result.raw);
    expect(new Date(parsed.date!).toISOString()).toBe(customDate.toISOString());
  });

  it("sets the Reply-To header", async () => {
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      replyTo: { name: "Support", address: "support@example.com" },
      subject: "Reply here",
      text: "test",
    });

    const parsed = await parse(result.raw);
    expect(parsed.replyTo?.[0]?.address).toBe("support@example.com");
  });

  it("includes a file attachment", async () => {
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      subject: "See attached",
      text: "Please review",
      attachments: [
        {
          filename: "report.txt",
          content: Buffer.from("quarterly numbers"),
          contentType: "text/plain",
        },
      ],
    });

    const parsed = await parse(result.raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("report.txt");
    expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer).toString()).toBe(
      "quarterly numbers",
    );
  });

  it("includes an inline image attachment with cid", async () => {
    const result = await buildRawMessage({
      from: alice,
      to: [bob],
      subject: "With image",
      html: '<p>Logo: <img src="cid:logo@kirimail" /></p>',
      attachments: [
        {
          filename: "logo.png",
          content: Buffer.from("fake-png-data"),
          contentType: "image/png",
          cid: "logo@kirimail",
        },
      ],
    });

    const parsed = await parse(result.raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.contentId).toBe("<logo@kirimail>");
    expect(parsed.attachments[0]?.disposition).toBe("inline");
  });

  // disableUrlAccess is also set, but the URL path (href) is only on
  // AmpAttachment, not Attachment - unreachable through our typed API.
  it("rejects attachments with file path content source", async () => {
    await expect(
      buildRawMessage({
        from: alice,
        to: [bob],
        subject: "Bad attachment",
        text: "test",
        attachments: [{ path: "/etc/passwd" }],
      }),
    ).rejects.toThrow(/[Ff]ile access rejected/);
  });

  it("throws when from address is null", async () => {
    const noAddress: MessageAddress = { name: "Ghost", address: null };

    await expect(
      buildRawMessage({
        from: noAddress,
        to: [bob],
        subject: "Fail",
        text: "test",
      }),
    ).rejects.toThrow("from address is required");
  });
});

describe("stripBcc", () => {
  it("removes the BCC header while preserving other headers", async () => {
    const { raw } = await buildRawMessage({
      from: alice,
      to: [bob],
      bcc: [carol],
      subject: "Secret copy",
      text: "test",
    });

    // Verify BCC is in the raw output (keepBcc = true)
    const before = await parse(raw);
    expect(before.bcc).toBeDefined();

    const stripped = await stripBcc(raw);
    const after = await parse(stripped);

    expect(after.bcc).toBeUndefined();
    expect(after.from?.address).toBe("alice@example.com");
    expect(after.subject).toBe("Secret copy");
  });

  it("handles multiple BCC recipients (potentially folded header)", async () => {
    const { raw } = await buildRawMessage({
      from: alice,
      to: [bob],
      bcc: [
        { name: "Recipient One", address: "r1@example.com" },
        { name: "Recipient Two", address: "r2@example.com" },
        { name: "Recipient Three", address: "r3@example.com" },
      ],
      subject: "Multi BCC",
      text: "test",
    });

    const stripped = await stripBcc(raw);
    const parsed = await parse(stripped);

    expect(parsed.bcc).toBeUndefined();
    expect(parsed.subject).toBe("Multi BCC");
  });

  it("is a no-op when no BCC header is present", async () => {
    const { raw } = await buildRawMessage({
      from: alice,
      to: [bob],
      subject: "No BCC",
      text: "test",
    });

    const stripped = await stripBcc(raw);
    const parsed = await parse(stripped);

    expect(parsed.bcc).toBeUndefined();
    expect(parsed.from?.address).toBe("alice@example.com");
    expect(parsed.subject).toBe("No BCC");
  });

  it("preserves body text and attachments after stripping", async () => {
    const { raw } = await buildRawMessage({
      from: alice,
      to: [bob],
      bcc: [carol],
      subject: "Full message",
      text: "Important body text",
      html: "<p>Rich content</p>",
      attachments: [
        {
          filename: "data.txt",
          content: Buffer.from("attachment payload"),
          contentType: "text/plain",
        },
      ],
    });

    const stripped = await stripBcc(raw);
    const parsed = await parse(stripped);

    expect(parsed.bcc).toBeUndefined();
    expect(parsed.text).toContain("Important body text");
    expect(parsed.html).toContain("<p>Rich content</p>");
    expect(parsed.attachments).toHaveLength(1);
    expect(Buffer.from(parsed.attachments[0]!.content as ArrayBuffer).toString()).toBe(
      "attachment payload",
    );
  });
});
