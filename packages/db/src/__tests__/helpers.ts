import type { AttachmentMetadata, FetchedMessage } from "@kirimail/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { generateId } from "../id";
import * as schema from "../schema";
import { emailAccounts, mailboxes, smtpIdentities, users } from "../schema";

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
export async function createTestUser(db: Db, overrides?: { id?: string; email?: string }) {
  const id = overrides?.id ?? generateId();
  await db.insert(users).values({
    id,
    name: "Test User",
    email: overrides?.email ?? `${id}@test.local`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/** Insert a minimal email account row. Returns the generated ID. */
export async function createTestEmailAccount(
  db: Db,
  userId: string,
  overrides?: { id?: string; emailAddress?: string },
) {
  const id = overrides?.id ?? generateId();
  await db.insert(emailAccounts).values({
    id,
    userId,
    emailAddress: overrides?.emailAddress ?? `account-${id}@test.local`,
    imapHost: "localhost",
    imapPort: 143,
    imapSecurity: "none",
    encryptedPassword: "encrypted-placeholder",
    keyVersion: 1,
  });
  return id;
}

/** Insert a minimal mailbox row. Returns the generated ID. */
export async function createTestMailbox(
  db: Db,
  emailAccountId: string,
  overrides?: { id?: string; path?: string; role?: string },
) {
  const id = overrides?.id ?? generateId();
  await db.insert(mailboxes).values({
    id,
    emailAccountId,
    path: overrides?.path ?? "INBOX",
    role: overrides?.role ?? "inbox",
  });
  return id;
}

/** Insert a minimal SMTP identity row. Returns the generated ID. */
export async function createTestSmtpIdentity(
  db: Db,
  emailAccountId: string,
  overrides?: { id?: string; fromAddress?: string },
) {
  const id = overrides?.id ?? generateId();
  await db.insert(smtpIdentities).values({
    id,
    emailAccountId,
    fromAddress: overrides?.fromAddress ?? `smtp-${id}@test.local`,
    smtpHost: "localhost",
    smtpPort: 587,
    smtpSecurity: "starttls",
    encryptedPassword: "encrypted-placeholder",
    keyVersion: 1,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Message factory
// ---------------------------------------------------------------------------

/** Auto-incrementing default UID so each built message is unique without manual override. */
let uidCounter = 1;

/** Build a FetchedMessage for testing. Accepts partial overrides. */
export function buildFetchedMessage(overrides?: {
  uid?: number;
  messageId?: string | null;
  subject?: string;
  from?: { name: string | null; address: string | null }[];
  to?: { name: string | null; address: string | null }[];
  inReplyTo?: string | null;
  references?: string | null;
  flags?: Set<string>;
  internalDate?: Date;
  sizeOctets?: number;
  attachments?: AttachmentMetadata[];
}): FetchedMessage {
  const uid = overrides?.uid ?? uidCounter++;
  return {
    uid,
    envelope: {
      date: new Date(),
      subject: overrides?.subject ?? `Test subject ${uid}`,
      from: overrides?.from ?? [{ name: "Sender", address: "sender@test.local" }],
      sender: [],
      replyTo: [],
      to: overrides?.to ?? [{ name: "Recipient", address: "recipient@test.local" }],
      cc: [],
      bcc: [],
      inReplyTo: overrides?.inReplyTo ?? null,
      messageId:
        overrides?.messageId === undefined ? `<msg-${uid}@test.local>` : overrides.messageId,
    },
    references: overrides?.references ?? null,
    flags: overrides?.flags ?? new Set(),
    internalDate: overrides?.internalDate ?? new Date(),
    sizeOctets: overrides?.sizeOctets ?? 1024,
    attachments: overrides?.attachments ?? [],
  };
}
