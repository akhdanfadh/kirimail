import { describe, expect, it } from "vitest";

import { classifySmtpError } from "../errors";

/**
 * Helper to build realistic nodemailer error objects. In production,
 * nodemailer's _formatError creates Error instances with .code,
 * .responseCode, .response, and .command set as properties.
 */
function smtpError(
  message: string,
  props?: { code?: string; responseCode?: number; command?: string },
) {
  return Object.assign(new Error(message), props);
}

describe("classifySmtpError", () => {
  // -------------------------------------------------------------------------
  // Real production error scenarios - representative nodemailer errors
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Classification ordering - precedence invariants that prevent misrouting
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Partial rejection: per-recipient errors from rejectedErrors[]
  //
  // When some RCPT TO succeed and some fail, nodemailer returns success with
  // info.rejectedErrors containing per-recipient error objects. The worker
  // handler may classify these individually to decide whether to notify the
  // sender about specific failed addresses.
  // -------------------------------------------------------------------------

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
