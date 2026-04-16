export type {
  ExpungeMessagesInput,
  FlagOperation,
  MoveMessagesInput,
  MoveResult,
  StoreFlagsInput,
} from "./commands";
export type { BuildRawMessageOptions, BuildRawMessageResult } from "./compose";
export type { ImapConnectionCacheOptions, ImapCredentials } from "./connection";
export type { CredentialEnvelope } from "./crypto";
export type { DiscoveryResult } from "./discovery";
export type {
  ClassifiedImapError,
  ImapErrorCategory,
  ClassifiedSmtpError,
  SmtpErrorCategory,
} from "./errors";
export type {
  ExistsInfo,
  ExpungeInfo,
  FlagsInfo,
  IdleConnectionStatus,
  IdleManagerOptions,
  ReconnectedInfo,
} from "./idle";
export type { BackoffConfig, ReconnectionManagerOptions } from "./reconnection";
export type {
  SmtpCredentials,
  SmtpEnvelope,
  SmtpSecurity,
  SmtpSendResult,
  SmtpTransportCacheOptions,
} from "./smtp";
export type {
  SyncMailboxesOptions,
  SyncMailboxInput,
  SyncMailboxResult,
  SyncMailboxesResult,
} from "./sync";
export type { ReferencedMessage } from "./threading";

export { expungeMessages, moveMessages, storeFlags } from "./commands";
export { buildRawMessage, stripBcc } from "./compose";
export { ImapConnectionCache } from "./connection";
export {
  decryptCredential,
  deserializeEnvelope,
  encryptCredential,
  serializeEnvelope,
} from "./crypto";
export { discoverMailboxes } from "./discovery";
export { mailEnv } from "./env";
export { classifyImapError, classifySmtpError } from "./errors";
export { IdleManager } from "./idle";
export { ReconnectionManager } from "./reconnection";
export { appendToSentFolder, SmtpTransportCache } from "./smtp";
export { syncMailboxes } from "./sync";
export { buildForwardHeaders, buildReplyHeaders } from "./threading";
