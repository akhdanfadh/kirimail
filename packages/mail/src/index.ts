export type {
  ExpungeMessagesInput,
  FlagOperation,
  MoveMessagesInput,
  MoveResult,
  StoreFlagsInput,
} from "./commands";
export type { ImapConnectionCacheOptions, ImapCredentials } from "./connection";
export type { CredentialEnvelope } from "./crypto";
export type { DiscoveryResult } from "./discovery";
export type {
  ExistsInfo,
  ExpungeInfo,
  FlagsInfo,
  IdleConnectionStatus,
  IdleManagerOptions,
  ReconnectedInfo,
} from "./idle";
export type {
  BackoffConfig,
  ClassifiedError,
  ImapErrorCategory,
  ReconnectionManagerOptions,
} from "./reconnection";
export type {
  SyncMailboxesOptions,
  SyncMailboxInput,
  SyncMailboxResult,
  SyncMailboxesResult,
} from "./sync";

export { expungeMessages, moveMessages, storeFlags } from "./commands";
export { ImapConnectionCache } from "./connection";
export {
  decryptCredential,
  deserializeEnvelope,
  encryptCredential,
  serializeEnvelope,
} from "./crypto";
export { discoverMailboxes } from "./discovery";
export { mailEnv } from "./env";
export { IdleManager } from "./idle";
export { ReconnectionManager } from "./reconnection";
export { syncMailboxes } from "./sync";
