import type { ImapCredentials } from "@kirimail/mail";
import type { InferSelectModel } from "drizzle-orm";

import { emailAccounts } from "@kirimail/db";
import { decryptCredential, deserializeEnvelope, mailEnv } from "@kirimail/mail";

/** Decrypt stored IMAP credentials and build an {@link ImapCredentials} object. */
export function resolveImapCredentials(
  account: InferSelectModel<typeof emailAccounts>,
): ImapCredentials {
  const key = Buffer.from(mailEnv.CREDENTIAL_ENCRYPTION_KEY, "hex");
  // NOTE: `deserializeEnvelope` and `decryptCredential` throw deterministically
  // on bad data - callers with retry logic (e.g., pg-boss jobs) will burn all retries.
  const envelope = deserializeEnvelope(account.encryptedPassword);
  const password = decryptCredential(envelope, key);
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
