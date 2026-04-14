import type { StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

// Import schema directly (not @kirimail/db) to avoid triggering the
// module-level Pool construction before DATABASE_URL is available.
import * as schema from "@kirimail/db/schema";
import { pushSchema } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { GenericContainer, Wait } from "testcontainers";

// ---------------------------------------------------------------------------
// Stalwart IMAP configuration (same as packages/mail test setup)
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
name = "syncuser"
secret = "testpass"
email.0000 = "syncuser@localhost"

[tracer."stdout"]
type = "stdout"
level = "info"
ansi = false
enable = true
`.trimStart();

// ---------------------------------------------------------------------------
// Vitest provided context
// ---------------------------------------------------------------------------

declare module "vitest" {
  export interface ProvidedContext {
    postgresUrl: string;
    stalwartHost: string;
    stalwartImapPort: number;
    encryptionKey: string;
  }
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

let pgContainer: StartedTestContainer;
let stalwartContainer: StartedTestContainer;

export async function setup(project: TestProject) {
  // Start both containers in parallel
  const [pg, stalwart] = await Promise.all([
    new GenericContainer("postgres:18-alpine")
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_DB: "kirimail_test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withWaitStrategy(Wait.forLogMessage(/ready to accept connections/, 2))
      .start(),

    new GenericContainer("stalwartlabs/stalwart:v0.15.5")
      .withCopyContentToContainer([
        { content: STALWART_CONFIG, target: "/opt/stalwart/etc/config.toml" },
      ])
      .withExposedPorts(143)
      .withWaitStrategy(Wait.forLogMessage(/network\.listen-start.*listenerId = "imap"/))
      .start(),
  ]);

  pgContainer = pg;
  stalwartContainer = stalwart;

  // Push Drizzle schema into kirimail_test - used as a template for per-worker
  // databases (CREATE DATABASE ... TEMPLATE) so test files can run in parallel.
  const host = pg.getHost();
  const port = pg.getMappedPort(5432);
  const postgresUrl = `postgresql://test:test@${host}:${port}/postgres`;
  const templateUrl = `postgresql://test:test@${host}:${port}/kirimail_test`;

  const templatePool = new Pool({ connectionString: templateUrl });
  const db = drizzle(templatePool);
  const { apply } = await pushSchema(schema, db);
  await apply();
  await templatePool.end();

  // Generate deterministic test encryption key (64 hex = 32 bytes for AES-256)
  const encryptionKey = randomBytes(32).toString("hex");

  project.provide("postgresUrl", postgresUrl);
  project.provide("stalwartHost", stalwart.getHost());
  project.provide("stalwartImapPort", stalwart.getMappedPort(143));
  project.provide("encryptionKey", encryptionKey);
}

export async function teardown() {
  await Promise.all([pgContainer?.stop(), stalwartContainer?.stop()]);
}
