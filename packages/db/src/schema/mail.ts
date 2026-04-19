import type { MessageAddress, SmtpErrorCategory } from "@kirimail/shared";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bytea,
  check,
  foreignKey,
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
    // Trivially unique (id is already PK), declared so composite foreign
    // keys on (email_account_id, id) — e.g., outbound_messages's ownership
    // check — have a targetable parent reference.
    unique("smtp_identities_email_account_id_id_uniq").on(table.emailAccountId, table.id),
  ],
);

/** Lifecycle status of an {@link outboundMessages} row. */
export type OutboundMessageStatus = "pending" | "sending" | "sent" | "failed";

/**
 * In-flight user-initiated outbound messages.
 *
 * One row per send request, written synchronously by the send API (MIME
 * built and validated up front) and consumed asynchronously by the SMTP
 * send and Sent-folder append workers. The last consumer should delete
 * the row on success. The authoritative record of a delivered send is the
 * Sent-folder copy, surfaced as a {@link messages} row on next IMAP sync.
 */
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: text("id").primaryKey(),
    emailAccountId: text("email_account_id")
      .notNull()
      .references(() => emailAccounts.id, { onDelete: "cascade" }),
    // The referencing FK is declared below as a composite key over
    // (emailAccountId, smtpIdentityId) so the DB enforces that the
    // identity belongs to the email account on the same row — otherwise
    // a buggy API could let user A send through user B's identity.
    smtpIdentityId: text("smtp_identity_id").notNull(),

    /**
     * Raw RFC 5322 bytes, BCC headers included. NOT NULL — a row exists
     * only to carry these bytes, and no consumer can act on an empty one
     * (the non-empty CHECK also catches the degenerate zero-length case).
     */
    rawMime: bytea("raw_mime").notNull(),
    /**
     * Angle-bracketed RFC 2822 Message-ID, stable across retries.
     * Uniqueness is enforced per email account.
     */
    messageId: text("message_id").notNull(),

    status: text("status").$type<OutboundMessageStatus>().notNull().default("pending"),
    /**
     * SMTP dispatch attempt counter at the domain layer.
     * Distinct from pg-boss's internal job retry counters.
     */
    attempts: integer("attempts").notNull().default(0),
    /** Classified category paired with `lastError`. Non-null iff `lastError` is non-null. */
    lastErrorCategory: text("last_error_category").$type<SmtpErrorCategory>(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("outbound_messages_email_account_id_idx").on(table.emailAccountId),
    unique("outbound_messages_email_account_id_message_id_uniq").on(
      table.emailAccountId,
      table.messageId,
    ),
    // Composite FK: enforces that the identity belongs to the email account
    // on the same row — column-level FKs alone only validate each target
    // exists, not that the two are related.
    //
    // Restrict: protects in-flight sends (pending/sending) from losing
    // their identity mid-transmission. `failed` rows also hold this FK;
    // the delete-identity API must clean them up in the same transaction.
    //
    // NOTE: Account deletion still succeeds because the cascade via
    // `emailAccountId` removes these rows before the `smtpIdentities`
    // cascade's restrict check evaluates. Relies on Postgres RI queue
    // ordering; verified by the cascade integration test. TODO: replace
    // with DEFERRABLE INITIALLY DEFERRED once Drizzle exposes it
    // (drizzle-team/drizzle-orm#1429).
    foreignKey({
      name: "outbound_messages_identity_owned_by_account_fk",
      columns: [table.emailAccountId, table.smtpIdentityId],
      foreignColumns: [smtpIdentities.emailAccountId, smtpIdentities.id],
    }).onDelete("restrict"),
    // rawMime must never be an empty buffer — a zero-length MIME payload
    // would indicate a caller bug and nothing would accept it downstream.
    check("outbound_messages_raw_mime_non_empty_chk", sql`octet_length(${table.rawMime}) > 0`),
    // lastError and lastErrorCategory must either both be null or both be
    // non-null — the category has no meaning without its message and vice versa.
    check(
      "outbound_messages_last_error_pair_chk",
      sql`(${table.lastError} IS NULL) = (${table.lastErrorCategory} IS NULL)`,
    ),
  ],
);
