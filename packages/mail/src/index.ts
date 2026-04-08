export type { CredentialEnvelope } from "./crypto";
export type { DiscoveryResult } from "./discovery";
export type {
  SyncMailboxesOptions,
  SyncMailboxInput,
  SyncMailboxResult,
  SyncMailboxesResult,
} from "./sync";

export {
  decryptCredential,
  deserializeEnvelope,
  encryptCredential,
  serializeEnvelope,
} from "./crypto";
export { discoverMailboxes } from "./discovery";
export { syncMailboxes } from "./sync";
