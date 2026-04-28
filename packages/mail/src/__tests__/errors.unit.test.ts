import { describe, expect, it } from "vitest";

import { ImapNonRetriableError } from "../commands";
import { asNonRetriableImapError, classifySmtpError } from "../errors";

/**
 * Build a realistic nodemailer error: nodemailer's _formatError sets
 * .code, .responseCode, .response, and .command on Error instances.
 */
function smtpError(
  message: string,
  props?: { code?: string; responseCode?: number; command?: string },
) {
  return Object.assign(new Error(message), props);
}

describe("classifySmtpError", () => {
  // Real production error scenarios - representative nodemailer errors.

  it("auth failure: server rejects credentials (EAUTH + 535)", () => {
    const err = smtpError("Invalid login: 535 5.7.8 Authentication credentials invalid", {
      code: "EAUTH",
      responseCode: 535,
      command: "AUTH PLAIN",
    });
    expect(classifySmtpError(err).category).toBe("auth");
  });

  it("all recipients rejected: every RCPT TO failed (EENVELOPE + 550)", () => {
    const err = smtpError("Can't send mail - all recipients were rejected", {
      code: "EENVELOPE",
      responseCode: 550,
      command: "RCPT TO",
    });
    const result = classifySmtpError(err);
    expect(result.category).toBe("recipient");
    expect(result.code).toBe("EENVELOPE");
  });

  it("provider throttle: too many connections (421)", () => {
    const err = smtpError("421 Too many connections from your IP", {
      responseCode: 421,
      command: "CONN",
    });
    expect(classifySmtpError(err).category).toBe("rate-limit");
  });

  it("network timeout: greeting never received (ETIMEDOUT)", () => {
    const err = smtpError("Greeting never received", {
      code: "ETIMEDOUT",
      command: "CONN",
    });
    expect(classifySmtpError(err).category).toBe("transient");
  });

  it("TLS handshake failure (ETLS)", () => {
    const err = smtpError("Failed to set up TLS session", {
      code: "ETLS",
      command: "STARTTLS",
    });
    expect(classifySmtpError(err).category).toBe("protocol");
  });

  it("pool closed during shutdown: no code, no responseCode", () => {
    const err = new Error("Connection pool was closed");
    expect(classifySmtpError(err).category).toBe("transient");
  });

  // Classification ordering - precedence invariants that prevent misrouting.

  it("550 is recipient, not protocol - prevents infinite retry on typo'd address", () => {
    const err = smtpError("550 User unknown", { responseCode: 550, command: "RCPT TO" });
    expect(classifySmtpError(err).category).toBe("recipient");
  });

  it("auth code beats transient responseCode - prevents retry on bad credentials", () => {
    // Hypothetical: server returns 4xx during auth negotiation
    const err = smtpError("Auth mechanism error", { code: "EAUTH", responseCode: 450 });
    expect(classifySmtpError(err).category).toBe("auth");
  });

  it("unknown error defaults to transient, not protocol - retrying is safer than dropping", () => {
    const err = smtpError("Something completely unexpected happened");
    expect(classifySmtpError(err).category).toBe("transient");
  });

  // Partial rejection: when some RCPT TO succeed and some fail, nodemailer
  // returns success with info.rejectedErrors holding per-recipient error
  // objects. Worker handlers classify these individually to decide whether
  // to notify the sender about specific failed addresses.

  it("per-recipient rejection from rejectedErrors classifies as recipient", () => {
    // Shape from nodemailer's _setEnvelope when individual RCPT TO fails
    const perRecipientErr = Object.assign(new Error("Recipient command failed: 550 User unknown"), {
      code: "EENVELOPE",
      responseCode: 550,
      command: "RCPT TO",
      recipient: "bad@example.com",
    });
    expect(classifySmtpError(perRecipientErr).category).toBe("recipient");
  });
});

/**
 * Build a realistic imapflow error: imapflow attaches `responseStatus` and
 * `executedCommand` (plus `serverResponseCode` after enhanceCommandError) on
 * NO/BAD; `authenticationFailed` on LOGIN/AUTHENTICATE rejection.
 * Connection-level errors (ECONNRESET, ETIMEOUT) carry only `code`.
 */
function imapError(
  message: string,
  props?: {
    authenticationFailed?: boolean;
    responseStatus?: string;
    executedCommand?: string;
    serverResponseCode?: string;
    code?: string;
  },
) {
  return Object.assign(new Error(message), props);
}

describe("asNonRetriableImapError", () => {
  // -- Deterministic shapes - wrap and return so the caller discards.

  it("auth failure: imapflow flags authenticationFailed on LOGIN", () => {
    // Mirrors imapflow's lib/commands/login.js:38. The auth check reads
    // only this flag - regression-guarded if it later starts requiring
    // responseStatus alongside.
    const err = imapError("Authentication failed", { authenticationFailed: true });
    expect(asNonRetriableImapError(err, "ctx")).toBeInstanceOf(ImapNonRetriableError);
  });

  it("mailbox not found: NO on SELECT", () => {
    const err = imapError("Command failed", {
      responseStatus: "NO",
      executedCommand: 'tag2 SELECT "Mailbox/Does/Not/Exist"',
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeInstanceOf(ImapNonRetriableError);
  });

  it("mailbox not found: NO on EXAMINE (read-only SELECT variant)", () => {
    // body-fetch opens the mailbox with `readOnly: true`, which sends
    // EXAMINE rather than SELECT.
    const err = imapError("Command failed", {
      responseStatus: "NO",
      executedCommand: 'tag3 EXAMINE "Mailbox/Does/Not/Exist"',
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeInstanceOf(ImapNonRetriableError);
  });

  it("server protocol error: BAD on UID FETCH", () => {
    // download(uid, partPath) issues UID FETCH BODY[partN]; a BAD reply is
    // a server protocol error - retries can't change the response.
    const err = imapError("Command failed", {
      responseStatus: "BAD",
      executedCommand: "tag4 UID FETCH 5 (BODY.PEEK[1])",
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeInstanceOf(ImapNonRetriableError);
  });

  it("mailbox not found: NO on STATUS (probe-then-lock path)", () => {
    // mailbox-append.ts:164 issues `client.status(mailbox, ...)` before lock.
    // For a vanished mailbox, STATUS returns NO and we must discard.
    const err = imapError("Command failed", {
      responseStatus: "NO",
      executedCommand: 'tag9 STATUS "Sent" (MESSAGES)',
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeInstanceOf(ImapNonRetriableError);
  });

  it("mailbox not found: NO with [NONEXISTENT] on COPY (verb-agnostic path)", () => {
    // RFC 5530 [NONEXISTENT] explicitly says the mailbox does not exist.
    // Verb-agnostic so it covers COPY/MOVE/APPEND, which aren't in the verb
    // list - servers that emit the bracket code get the discard regardless.
    const err = imapError("Command failed", {
      responseStatus: "NO",
      executedCommand: 'tag10 UID COPY 1:5 "Archive"',
      serverResponseCode: "NONEXISTENT",
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeInstanceOf(ImapNonRetriableError);
  });

  it("mailbox not found: NO with [TRYCREATE] on APPEND (destination gone)", () => {
    // RFC 3501 [TRYCREATE] on APPEND/COPY indicates the destination doesn't
    // exist - same outcome as NONEXISTENT; discard.
    const err = imapError("Command failed", {
      responseStatus: "NO",
      executedCommand: 'tag11 APPEND "Sent" (\\Seen)',
      serverResponseCode: "TRYCREATE",
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeInstanceOf(ImapNonRetriableError);
  });

  // -- Non-deterministic shapes - return undefined so the caller bubbles for retry.

  it("NO on FETCH falls through: imapflow swallows the canonical 'no longer exist' NO", () => {
    // imapflow's lib/imap-flow.js:752 turns NO + 'Some of the requested
    // messages no longer exist' into a successful partial response, so any
    // NO that does surface on FETCH is a server quirk we shouldn't auto-discard.
    const err = imapError("Command failed", {
      responseStatus: "NO",
      executedCommand: "tag5 UID FETCH 5 (BODY.PEEK[1])",
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeUndefined();
  });

  it("BAD on SELECT falls through: rare in practice, treat as transient", () => {
    const err = imapError("Command failed", {
      responseStatus: "BAD",
      executedCommand: 'tag6 SELECT "INBOX"',
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeUndefined();
  });

  it("[INUSE] on SELECT falls through: another session holds an exclusive lock", () => {
    // RFC 5530 [INUSE] is genuinely transient - the holding session may
    // release before the next retry.
    const err = imapError("Command failed", {
      responseStatus: "NO",
      executedCommand: 'tag7 SELECT "INBOX"',
      serverResponseCode: "INUSE",
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeUndefined();
  });

  it("BAD on SELECT 'FETCH' mailbox does not misclassify as BAD-on-FETCH", () => {
    // Defends against a substring-match regression: a BAD on SELECT for a
    // mailbox literally named "FETCH/Bot" must fall through (BAD on SELECT
    // is out of scope), not get classified as "BAD on FETCH".
    const err = imapError("Command failed", {
      responseStatus: "BAD",
      executedCommand: 'tag8 SELECT "Archive/FETCH-Bot"',
    });
    expect(asNonRetriableImapError(err, "ctx")).toBeUndefined();
  });

  it("connection-level error: no responseStatus, must retry", () => {
    // Socket drops, server BYE, ETIMEOUT, NoConnection all share one
    // fall-through path (no responseStatus, no executedCommand) - one
    // representative case suffices.
    const err = imapError("read ECONNRESET", { code: "ECONNRESET" });
    expect(asNonRetriableImapError(err, "ctx")).toBeUndefined();
  });

  // -- Defensive: malformed / unexpected error values must not throw or wrap.

  it("null defaults to undefined (graceful close, no error to classify)", () => {
    // imapflow's close event always fires with null; classifyImapError handles
    // this same shape on the connection-lifecycle side.
    expect(asNonRetriableImapError(null, "ctx")).toBeUndefined();
  });

  it("plain Error with no imapflow fields defaults to undefined", () => {
    // Pins fall-through for any unrecognized object error - the caller's
    // `instanceof ImapNonRetriableError` check handles the typed-error path
    // separately.
    expect(asNonRetriableImapError(new Error("unexpected"), "ctx")).toBeUndefined();
  });

  // -- Wrap contract: cause preservation + context prefixing.

  it("preserves the original on cause and prepends contextMessage", () => {
    const original = imapError("Authentication failed", { authenticationFailed: true });
    const wrapped = asNonRetriableImapError(original, 'IMAP fetch failed (mailbox: "INBOX")');
    expect(wrapped).toBeInstanceOf(ImapNonRetriableError);
    expect(wrapped!.cause).toBe(original);
    // Context message is prepended; original message is appended.
    expect(wrapped!.message).toBe('IMAP fetch failed (mailbox: "INBOX"): Authentication failed');
  });
});
