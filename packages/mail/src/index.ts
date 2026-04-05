export type {
  CredentialEnvelope,
  DiscoveredMailbox,
  DiscoveryResult,
  ImapCredentials,
  MailboxRole,
  SyncAction,
  SyncCursor,
} from "./types";
export { createImapClient, withImapConnection } from "./connection";
export {
  decryptCredential,
  deserializeEnvelope,
  encryptCredential,
  serializeEnvelope,
} from "./crypto";
export { discoverMailboxes } from "./discovery";
export { mapMailboxRole } from "./role-map";
export { compareSyncCursors } from "./sync-cursor";
