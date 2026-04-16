import type { MessageAddress } from "@kirimail/shared";

import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { users } from "./better-auth";

/** Connected email accounts with encrypted IMAP credentials. */
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailAddress: text("email_address").notNull(),

    // IMAP connection
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapSecurity: text("imap_security").notNull(),

    // Credential encryption
    encryptedPassword: text("encrypted_password").notNull(),
    keyVersion: integer("key_version").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("email_accounts_user_id_idx").on(table.userId)],
);

/** IMAP mailboxes discovered per email account. */
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    emailAccountId: text("email_account_id")
      .notNull()
      .references(() => emailAccounts.id, { onDelete: "cascade" }),

    // IMAP identity
    path: text("path").notNull(),
    delimiter: text("delimiter"),
    specialUse: text("special_use"),
    role: text("role").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => mailboxes.id, {
      onDelete: "cascade",
    }),

    // IMAP sync cursor state
    // - `bigint` as IMAP UIDs are 32-bit per RFC 3501 #2.3.1.1 and unsigned per #9
    // - `mode: "number"` uses JS number internally as BigInt is not JSON-serializable per ECMA-262 #25.5.2.2
    uidValidity: bigint("uid_validity", { mode: "number" }),
    uidNext: bigint("uid_next", { mode: "number" }),
    messageCount: integer("message_count"),
    highestModseq: bigint("highest_modseq", { mode: "number" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("mailboxes_email_account_id_idx").on(table.emailAccountId),
    index("mailboxes_parent_id_idx").on(table.parentId),
    unique("mailboxes_email_account_id_path_uniq").on(table.emailAccountId, table.path),
  ],
);

/**
 * Synced email messages, one row per mailbox copy.
 *
 * In standard IMAP each message exists in exactly one mailbox, so one
 * synced email = one row. The unique constraint on
 * `(mailboxId, providerUid, uidValidity)` guarantees idempotent sync.
 *
 * `headerMessageId` is kept as a plain column for threading queries
 * (matching In-Reply-To / References) but has no uniqueness constraint
 * since the same Message-ID can legitimately appear in multiple mailboxes
 * (e.g., IMAP COPY).
 */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),

    // IMAP sync identity
    providerUid: bigint("provider_uid", { mode: "number" }).notNull(),
    uidValidity: bigint("uid_validity", { mode: "number" }).notNull(),

    // Envelope fields
    headerMessageId: text("header_message_id"),
    subject: text("subject"),
    inReplyTo: text("in_reply_to"),
    references: text("references"),
    sentDate: timestamp("sent_date", { withTimezone: true }),

    // Address arrays as jsonb
    fromAddress: jsonb("from_address").$type<MessageAddress[]>().notNull().default([]),
    senderAddress: jsonb("sender_address").$type<MessageAddress[]>().notNull().default([]),
    replyToAddress: jsonb("reply_to_address").$type<MessageAddress[]>().notNull().default([]),
    toAddress: jsonb("to_address").$type<MessageAddress[]>().notNull().default([]),
    ccAddress: jsonb("cc_address").$type<MessageAddress[]>().notNull().default([]),
    bccAddress: jsonb("bcc_address").$type<MessageAddress[]>().notNull().default([]),

    // Per-copy IMAP metadata
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    internalDate: timestamp("internal_date", { withTimezone: true }).notNull(),
    sizeOctets: integer("size_octets").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("messages_mailbox_id_idx").on(table.mailboxId),
    index("messages_header_message_id_idx").on(table.headerMessageId),
    unique("messages_mailbox_uid_validity_uniq").on(
      table.mailboxId,
      table.providerUid,
      table.uidValidity,
    ),
  ],
);

/**
 * SMTP send identities linked to an email account.
 *
 * Separate from `emailAccounts` because SMTP is a universal send mechanism
 * that exists independently of the read adapter (IMAP, Gmail API, JMAP).
 * Provides 1:N send-as support per account without schema migration.
 *
 */
export const smtpIdentities = pgTable(
  "smtp_identities",
  {
    id: text("id").primaryKey(),
    emailAccountId: text("email_account_id")
      .notNull()
      .references(() => emailAccounts.id, { onDelete: "cascade" }),
    fromAddress: text("from_address").notNull(),

    // SMTP connection
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    /** Stores `SmtpSecurity` values from `@kirimail/mail` - "tls" | "starttls" | "none" (dev/test only). */
    smtpSecurity: text("smtp_security").notNull(),
    /** Whether to validate the server's TLS certificate. Default: true. Set false only for self-signed certs. */
    rejectUnauthorized: boolean("reject_unauthorized").notNull().default(true),

    // Credential encryption (same AES-256-GCM CredentialEnvelope as emailAccounts)
    encryptedPassword: text("encrypted_password").notNull(),
    keyVersion: integer("key_version").notNull().default(1),

    // NOTE: Add isPrimary when the add-account flow needs a default "from" identity for compose.
    // isPrimary: boolean("is_primary").notNull().default(false),
    appendToSent: boolean("append_to_sent").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("smtp_identities_email_account_id_idx").on(table.emailAccountId),
    unique("smtp_identities_email_account_id_from_address_uniq").on(
      table.emailAccountId,
      table.fromAddress,
    ),
  ],
);
