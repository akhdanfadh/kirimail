import type { ImapCredentials } from "@kirimail/mail";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@kirimail/db/schema";
import { encryptCredential, serializeEnvelope } from "@kirimail/mail";
import { withImapConnection } from "@kirimail/mail/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { inject } from "vitest";

type Db = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

/** Create a Drizzle client connected to the per-worker test database. */
export function createTestDb(): { db: Db; pool: Pool } {
  // Uses process.env (not inject) because the per-worker database URL is
  // constructed in setup-env.ts, not in globalSetup - inject only carries
  // values from globalSetup's project.provide().
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

// ---------------------------------------------------------------------------
// Seed factories
// ---------------------------------------------------------------------------

/** Insert a minimal user row. Returns the generated ID. */
export async function createTestUser(db: Db) {
  const id = randomUUID();
  await db.insert(schema.users).values({
    id,
    name: "Test User",
    email: `${id}@test.local`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/**
 * Insert an email account with properly encrypted IMAP credentials
 * pointing to the Stalwart test container. Returns the account ID.
 */
export async function createEncryptedEmailAccount(
  db: Db,
  userId: string,
  overrides?: { emailUser?: string; emailPass?: string },
) {
  const id = randomUUID();
  const key = Buffer.from(inject("encryptionKey"), "hex");
  const emailUser = overrides?.emailUser ?? "syncuser";
  const emailPass = overrides?.emailPass ?? "testpass";
  const envelope = encryptCredential(emailPass, key, 1);

  // Stalwart's memory directory authenticates by principal name (e.g.,
  // "syncuser"), not full email. The sync handler uses emailAddress as
  // the IMAP user, so we store the principal name here.
  await db.insert(schema.emailAccounts).values({
    id,
    userId,
    emailAddress: emailUser,
    imapHost: inject("stalwartHost"),
    imapPort: inject("stalwartImapPort"),
    imapSecurity: "none",
    encryptedPassword: serializeEnvelope(envelope),
    keyVersion: 1,
  });
  return id;
}

// ---------------------------------------------------------------------------
// IMAP cleanup
// ---------------------------------------------------------------------------

/**
 * Clean all messages and custom mailboxes from the test user's account.
 * Call in beforeEach to ensure a fresh IMAP state per test.
 */
export async function cleanImapState(creds: ImapCredentials) {
  await withImapConnection(creds, async (client) => {
    // Delete user-created mailboxes (skip INBOX and system folders)
    const list = await client.list();
    for (const mbx of list) {
      const isSystem =
        mbx.path === "INBOX" || mbx.specialUse !== undefined || mbx.flags.has("\\Noselect");
      if (!isSystem) {
        await client.mailboxDelete(mbx.path);
      }
    }

    // Clear INBOX messages
    const status = await client.status("INBOX", { messages: true });
    if (status.messages && status.messages > 0) {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageDelete({ all: true });
      } finally {
        lock.release();
      }
    }
  });
}
