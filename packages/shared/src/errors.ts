/** Category of an IMAP error, determining retry strategy. */
export type ImapErrorCategory =
  | "auth" // bad credentials
  | "transient" // network hiccup, worth retrying
  | "rate-limit" // provider throttling
  | "protocol"; // non-retryable server error, catch-all

/** Retryable subset of {@link ImapErrorCategory}. */
export type RetryableImapErrorCategory = Extract<ImapErrorCategory, "transient" | "rate-limit">;

/**
 * Category of an SMTP error, determining retry strategy.
 *
 * `classifySmtpError` in @kirimail/mail produces `auth`, `transient`,
 * `rate-limit`, `recipient`, and `protocol`. The remaining two are stamped
 * locally: `precondition` before SMTP is contacted; `delivery-unknown` by
 * the sending-row reaper when a row stalls in `sending`.
 */
export type SmtpErrorCategory =
  | "auth" // bad credentials (EAUTH, ENOAUTH, EOAUTH2, 535)
  | "transient" // network hiccup, worth retrying
  | "rate-limit" // provider throttling (421)
  | "recipient" // invalid address (EENVELOPE, 550, 553)
  | "protocol" // non-retryable server error (ETLS, EPROTOCOL, other 5xx)
  | "precondition" // local precondition failed; SMTP was never contacted
  | "delivery-unknown"; // handler crashed mid-send; delivery status indeterminate

/** Retryable subset of {@link SmtpErrorCategory}. */
export type RetryableSmtpErrorCategory = Extract<SmtpErrorCategory, "transient" | "rate-limit">;
