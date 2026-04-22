import type Mail from "nodemailer/lib/mailer";
import type { StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

import MailComposer from "nodemailer/lib/mail-composer";
import { GenericContainer, Wait } from "testcontainers";
import { inject } from "vitest";

import type { ImapCredentials } from "../connection";

import { withImapConnection } from "../connection";

// ---------------------------------------------------------------------------
// Container configuration
// ---------------------------------------------------------------------------

const STALWART_CONFIG = `
[server]
hostname = "localhost"
max-connections = 8192

[server.listener.imap]
bind = "[::]:143"
protocol = "imap"

[server.listener.http]
bind = "[::]:8080"
protocol = "http"

[storage]
data = "rocksdb"
fts = "rocksdb"
blob = "rocksdb"
lookup = "rocksdb"
directory = "memory"

[store."rocksdb"]
type = "rocksdb"
path = "/opt/stalwart/data"
compression = "lz4"

[directory."memory"]
type = "memory"

[directory."memory".principals.0000]
class = "admin"
name = "admin"
secret = "testadmin"
email.0000 = "admin@localhost"

[directory."memory".principals.0001]
class = "individual"
name = "discoveryuser"
secret = "testpass"
email.0000 = "discoveryuser@localhost"

[directory."memory".principals.0002]
class = "individual"
name = "syncuser"
secret = "testpass"
email.0000 = "syncuser@localhost"

[directory."memory".principals.0003]
class = "individual"
name = "commandsuser"
secret = "testpass"
email.0000 = "commandsuser@localhost"

[directory."memory".principals.0004]
class = "individual"
name = "reconnectuser"
secret = "testpass"
email.0000 = "reconnectuser@localhost"

[directory."memory".principals.0005]
class = "individual"
name = "idleuser"
secret = "testpass"
email.0000 = "idleuser@localhost"

[directory."memory".principals.0006]
class = "individual"
name = "mailboxuploaduser"
secret = "testpass"
email.0000 = "mailboxuploaduser@localhost"
`.trimStart();

// ---------------------------------------------------------------------------
// Vitest global setup / teardown
// ---------------------------------------------------------------------------

declare module "vitest" {
  export interface ProvidedContext {
    stalwartHost: string;
    stalwartImapPort: number;
  }
}

let container: StartedTestContainer;

/** Testcontainers global setup: start Stalwart once for all tests. */
export async function setup(project: TestProject) {
  container = await new GenericContainer("stalwartlabs/stalwart:v0.15.5")
    .withCopyContentToContainer([
      { content: STALWART_CONFIG, target: "/opt/stalwart/etc/config.toml" },
    ])
    .withExposedPorts(143)
    .withHealthCheck({
      test: ["CMD-SHELL", "stalwart-cli -u http://localhost:8080 -a server healthcheck"],
      interval: 500,
      timeout: 3_000,
      retries: 120,
    })
    .withStartupTimeout(120_000)
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  project.provide("stalwartHost", container.getHost());
  project.provide("stalwartImapPort", container.getMappedPort(143));
}

export async function teardown() {
  await container?.stop();
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build {@link ImapCredentials} for the Stalwart test container. */
export function testCredentials(user: string, pass = "testpass"): ImapCredentials {
  return {
    host: inject("stalwartHost"),
    port: inject("stalwartImapPort"),
    secure: false,
    user,
    pass,
  };
}

/** RFC 5322 header values for the seeded message. */
export interface SeedMessageHeaders {
  /** From address. Defaults to "sender@localhost". */
  from?: string;
  /** To address. Defaults to the credential user's address (e.g., "admin@localhost"). */
  to?: string;
  /** Subject header. */
  subject?: string;
  /** Date header value. Defaults to current time. */
  date?: Date;
  /** Message-ID header. */
  messageId?: string;
  /** In-Reply-To header for threading. */
  inReplyTo?: string;
  /** References header for threading (space-delimited message IDs). */
  references?: string;
}

export interface SeedMessageOptions {
  /** RFC 5322 headers for the message. */
  headers?: SeedMessageHeaders;
  /** Plain text body. Defaults to "Test message body." */
  text?: string;
  /**
   * HTML body. When set, the seeded message is built with MailComposer and
   * produces a multipart structure (multipart/alternative when combined with
   * `text`, or multipart/related when combined with cid-bearing attachments).
   */
  html?: string;
  /**
   * File attachments passed through to MailComposer. Inline images use
   * `{cid, content, contentType: "image/..."}`; forwarded messages use
   * `{contentType: "message/rfc822", content: <raw RFC 5322 Buffer>}`.
   * Presence of this field (or `html`) switches the builder to MailComposer.
   */
  attachments?: Mail.Attachment[];
  /** Target mailbox for APPEND. Defaults to "INBOX". */
  mailbox?: string;
  /** IMAP flags to set on the message (e.g., "\\Seen", "\\Flagged"). */
  flags?: string[];
  /** IMAP internal date (server receive timestamp). Passed to APPEND. */
  internalDate?: Date;
}

/**
 * Build a raw RFC 5322 message for APPEND. Uses MailComposer when the
 * message needs MIME structure (html body or attachments), falls back to
 * hand-rolled single-part text/plain for the simple case.
 */
async function buildRawMessage(options: SeedMessageOptions): Promise<Buffer> {
  const h = options.headers ?? {};
  const isMultipart =
    options.html != null || (options.attachments && options.attachments.length > 0);

  if (isMultipart) {
    // `date` here is the RFC 5322 Date: header inside the message body;
    // `options.internalDate` is the IMAP APPEND timestamp (server-receive
    // time), threaded separately through `client.append` in `seedMessage`.
    const composer = new MailComposer({
      from: h.from ?? "sender@localhost",
      to: h.to ?? "user@localhost",
      date: h.date ?? new Date(),
      messageId: h.messageId,
      subject: h.subject,
      inReplyTo: h.inReplyTo,
      references: h.references,
      text: options.text ?? "Test message body.",
      html: options.html,
      attachments: options.attachments,
    });
    return await composer.compile().build();
  }

  const lines = [
    `From: ${h.from ?? "sender@localhost"}`,
    `To: ${h.to ?? "user@localhost"}`,
    `Date: ${(h.date ?? new Date()).toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
  ];

  if (h.messageId) lines.push(`Message-ID: ${h.messageId}`);
  if (h.subject) lines.push(`Subject: ${h.subject}`);
  if (h.inReplyTo) lines.push(`In-Reply-To: ${h.inReplyTo}`);
  if (h.references) lines.push(`References: ${h.references}`);

  lines.push("", options.text ?? "Test message body.");
  return Buffer.from(lines.join("\r\n"));
}

/**
 * Seed a message into a user's INBOX via IMAP APPEND.
 *
 * We use IMAP APPEND instead of SMTP to seed messages. Stalwart's SMTP on
 * port 25 runs in relay mode, which applies SPF/DMARC/reverse-DNS checks on
 * every inbound connection. For Testcontainers usage, these lookups time out
 * or fail unpredictably on the bridge network, causing Stalwart to silently
 * drop the connection mid-session.
 *
 * IMAP APPEND (RFC 3502) is the standard way to inject a raw message directly
 * into a mailbox, bypassing the entire SMTP delivery pipeline. Stalwart's own
 * test suite uses the same approach. It is deterministic - the message exists
 * in the mailbox when the promise resolves - and since we are testing IMAP
 * behavior, the delivery mechanism is irrelevant; only the resulting mailbox
 * state matters.
 */
export async function seedMessage(creds: ImapCredentials, options?: SeedMessageOptions) {
  const defaultHeaders: SeedMessageHeaders = { to: `${creds.user}@localhost` };
  const merged: SeedMessageOptions = {
    ...options,
    headers: { ...defaultHeaders, ...options?.headers },
  };
  const raw = await buildRawMessage(merged);
  const mailbox = options?.mailbox ?? "INBOX";
  const flags = options?.flags ?? [];
  await withImapConnection(creds, async (client) => {
    await client.append(mailbox, raw, flags, options?.internalDate);
  });
}
