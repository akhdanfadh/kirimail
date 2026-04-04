import { createTransport } from "nodemailer";
import { beforeAll, describe, expect, inject, it } from "vitest";

import type { ImapCredentials } from "../types";

import { discoverMailboxes } from "../discovery";

function getTestCredentials(): ImapCredentials {
  return {
    host: inject("greenmailHost"),
    port: inject("greenmailImapPort"),
    secure: false,
    user: "testuser",
    pass: "testpass",
  };
}

async function seedMessage() {
  const transport = createTransport({
    host: inject("greenmailHost"),
    port: inject("greenmailSmtpPort"),
    secure: false,
  });
  await transport.sendMail({
    from: "sender@localhost",
    to: "testuser@localhost",
    subject: "Test message for discovery",
    text: "Hello from the integration test.",
  });
}

describe("discoverMailboxes (GreenMail integration)", () => {
  beforeAll(async () => {
    await seedMessage();
  });

  it("discovers INBOX with role inbox", async () => {
    const result = await discoverMailboxes(getTestCredentials());

    const inbox = result.mailboxes.find((mb) => mb.role === "inbox");

    expect(inbox).toBeDefined();
    expect(inbox!.path).toBe("INBOX");
  });

  it("throws on invalid credentials", async () => {
    const creds: ImapCredentials = {
      ...getTestCredentials(),
      pass: "wrongpassword",
    };

    await expect(discoverMailboxes(creds)).rejects.toThrow();
  });
});
