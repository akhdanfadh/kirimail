/** Normalized mailbox roles used across the app. */
export type MailboxRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "custom";

/** A mailbox discovered via IMAP LIST with normalized role and hierarchy. */
export interface DiscoveredMailbox {
  path: string;
  delimiter: string | null;
  role: MailboxRole;
  specialUse: string | null;
  children: DiscoveredMailbox[];
}

/** Result of mailbox discovery for an IMAP account. */
export interface DiscoveryResult {
  mailboxes: DiscoveredMailbox[];
}

/** Credentials needed to connect to an IMAP server. */
export interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** AES-256-GCM encrypted credential envelope for DB storage. */
export interface CredentialEnvelope {
  iv: string;
  ciphertext: string;
  authTag: string;
  keyVersion: number;
}
