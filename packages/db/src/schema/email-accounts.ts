import {
  type AnyPgColumn,
  bigint,
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
    // - `bigint` as message UIDs are 32-bit per RFC 3501 §2.3.1.1 and unsigned per §9
    // - `mode: "number"` uses JS number internally as BigInt is not JSON-serializable per ECMA-262 §25.5.2.2
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
