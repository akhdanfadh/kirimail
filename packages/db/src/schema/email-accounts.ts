import {
  type AnyPgColumn,
  index,
  integer,
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
    /** AES-256-GCM envelope as JSON string: {iv, ciphertext, authTag} in base64. */
    encryptedPassword: text("encrypted_password").notNull(),
    /** Encryption key version: queryable for bulk re-encryption after key rotation. */
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
    /** Provider hierarchy separator (e.g. "/" or ".") used to derive parent-child structure. */
    delimiter: text("delimiter"),

    // App-level classification
    /** Normalized app role: inbox, sent, drafts, trash, junk, archive, or custom. */
    role: text("role").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => mailboxes.id, {
      onDelete: "cascade",
    }),
    /** Raw RFC 6154 special-use attribute from provider (e.g. "\\Sent") for role-map debugging. */
    specialUse: text("special_use"),

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
