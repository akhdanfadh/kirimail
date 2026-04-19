import type { ImapCredentials, SmtpCredentials, SmtpSecurity } from "@kirimail/mail";
import type { InferSelectModel } from "drizzle-orm";

import { emailAccounts, smtpIdentities } from "@kirimail/db";
import { decryptCredential, deserializeEnvelope, mailEnv } from "@kirimail/mail";

// Module-level so we don't Buffer.from-decode the hex key on every job.
// mailEnv is validated at import time, so the key shape is trusted here.
const encryptionKey = Buffer.from(mailEnv.CREDENTIAL_ENCRYPTION_KEY, "hex");

/** Decrypt stored IMAP credentials and build an {@link ImapCredentials} object. */
export function resolveImapCredentials(
  account: InferSelectModel<typeof emailAccounts>,
): ImapCredentials {
  // NOTE: `deserializeEnvelope` and `decryptCredential` throw deterministically
  // on bad data - callers with retry logic (e.g., pg-boss jobs) will burn all retries.
  const envelope = deserializeEnvelope(account.encryptedPassword);
  const password = decryptCredential(envelope, encryptionKey);
  // TODO: Classify permanent vs transient errors when account error states
  // are UI-visible (e.g., "invalid credentials" badge on the account settings page).
  return {
    host: account.imapHost,
    pass: password,
    port: account.imapPort,
    secure: account.imapSecurity === "tls",
    user: account.emailAddress,
  };
}

/** Decrypt stored SMTP credentials and build an {@link SmtpCredentials} object. */
export function resolveSmtpCredentials(
  identity: InferSelectModel<typeof smtpIdentities>,
): SmtpCredentials {
  const envelope = deserializeEnvelope(identity.encryptedPassword);
  const password = decryptCredential(envelope, encryptionKey);
  return {
    host: identity.smtpHost,
    port: identity.smtpPort,
    security: identity.smtpSecurity as SmtpSecurity,
    auth: { user: identity.fromAddress, pass: password },
    rejectUnauthorized: identity.rejectUnauthorized,
  };
}
