import { describe, expect, it } from "vitest";

import { detectProviderIdleConfig } from "../idle";

describe("detectProviderIdleConfig", () => {
  it("returns 3 min for Yahoo hosts with standard IDLE", () => {
    // Yahoo drops IDLE connections after ~3 min. The pattern is broader than
    // EmailEngine's (\.yahoo\.com$) to cover country TLDs like .co.jp, .co.uk.
    const config = detectProviderIdleConfig("imap.mail.yahoo.com");
    expect(config.maxIdleTimeMs).toBe(3 * 60 * 1000);
    expect(config.missingIdleCommand).toBeUndefined();

    expect(detectProviderIdleConfig("imap.yahoo.CO.JP").maxIdleTimeMs).toBe(3 * 60 * 1000);
  });

  it("returns STATUS polling for 163.com and Coremail hosts", () => {
    // Coremail (powering 163.com and others) ignores IDLE and NOOP - STATUS is
    // the only command the server treats as real activity.
    const netease = detectProviderIdleConfig("imap.163.COM");
    expect(netease.maxIdleTimeMs).toBe(55_000);
    expect(netease.missingIdleCommand).toBe("STATUS");

    // Bare "coremail" substring matches by design: Coremail powers many Chinese
    // providers with varied hostnames (e.g., mail.coremail.cn, imap.coremail.net).
    const coremail = detectProviderIdleConfig("mail.coremail.cn");
    expect(coremail.maxIdleTimeMs).toBe(55_000);
    expect(coremail.missingIdleCommand).toBe("STATUS");
  });

  it("returns short timeout with standard IDLE for Rambler", () => {
    // Rambler supports real IDLE but needs frequent restarts.
    const config = detectProviderIdleConfig("imap.RAMBLER.ru");
    expect(config.maxIdleTimeMs).toBe(55_000);
    expect(config.missingIdleCommand).toBeUndefined();
  });

  it("returns RFC-default config for providers without overrides", () => {
    const gmail = detectProviderIdleConfig("imap.gmail.com");
    expect(gmail.maxIdleTimeMs).toBe(25 * 60 * 1000);
    expect(gmail.missingIdleCommand).toBeUndefined();

    // Unknown/self-hosted providers also get the default.
    expect(detectProviderIdleConfig("mail.example.com").maxIdleTimeMs).toBe(25 * 60 * 1000);
  });
});
