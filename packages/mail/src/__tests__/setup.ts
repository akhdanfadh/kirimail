import type { StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

import { GenericContainer, Wait } from "testcontainers";
import { inject } from "vitest";

import type { ImapCredentials } from "../types";

import { withImapConnection } from "../connection";

// ---------------------------------------------------------------------------
// Container configuration
// ---------------------------------------------------------------------------

const STALWART_CONFIG = `
[server]
hostname = "localhost"
max-connections = 8192

[server.listener."imap"]
bind = ["[::]:143"]
protocol = "imap"

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
name = "testuser"
secret = "testpass"
email.0000 = "testuser@localhost"

[tracer."stdout"]
type = "stdout"
level = "info"
ansi = false
enable = true
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
    .withWaitStrategy(Wait.forLogMessage(/network\.listen-start.*listenerId = "imap"/))
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

export interface SeedMessageOptions {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
}

/**
 * Build a minimal RFC 5322 message as raw bytes.
 *
 * IMAP APPEND requires a fully formed email (headers + body) unlike SMTP where
 * the transport library constructs the message for you.
 */
function buildRawMessage(options: SeedMessageOptions): Buffer {
  const lines = [
    `From: ${options.from ?? "sender@localhost"}`,
    `To: ${options.to ?? "user@localhost"}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
  ];

  if (options.subject) lines.push(`Subject: ${options.subject}`);

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
  const raw = buildRawMessage({ to: `${creds.user}@localhost`, ...options });
  await withImapConnection(creds, async (client) => {
    await client.append("INBOX", raw, []);
  });
}
