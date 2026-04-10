export type {
  ExpungeMessagesInput,
  FlagOperation,
  MoveMessagesInput,
  StoreFlagsInput,
} from "./commands";
export type { ImapCredentials } from "./connection";
export type { CredentialEnvelope } from "./crypto";
export type { DiscoveryResult } from "./discovery";
export type {
  SyncMailboxesOptions,
  SyncMailboxInput,
  SyncMailboxResult,
  SyncMailboxesResult,
} from "./sync";

export { expungeMessages, moveMessages, storeFlags } from "./commands";
export {
  decryptCredential,
  deserializeEnvelope,
  encryptCredential,
  serializeEnvelope,
} from "./crypto";
export { discoverMailboxes } from "./discovery";
export { mailEnv } from "./env";
export { syncMailboxes } from "./sync";
