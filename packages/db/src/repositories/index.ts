export type { InsertDomainEventInput } from "./domain-event";
export type { InsertOutboundMessageInput } from "./outbound-messages";

export {
  insertDomainEvent,
  insertDomainEvents,
  listUnconsumedDomainEvents,
  markDomainEventConsumed,
  markDomainEventFailed,
} from "./domain-event";
export { getEmailAccountById, listAllEmailAccountIds } from "./email-account";
export { applyMailboxSync, findMailboxPathByRole, reconcileMailboxes } from "./mailbox";
export {
  deleteOutboundMessage,
  getOutboundMessageById,
  insertOutboundMessage,
  markOutboundMessageFailed,
  markPendingOutboundMessageSending,
  markSendingOutboundMessageSent,
  reapStaleSendingOutboundMessages,
  reapStaleSentOutboundMessages,
  resetSendingOutboundMessageToPending,
  retryFailedOutboundMessage,
} from "./outbound-messages";
export { getSmtpIdentityById } from "./smtp-identity";
