import type { TestProject } from "vitest/node";

import { GenericContainer, Wait } from "testcontainers";

/** Testcontainers global setup: start GreenMail once for all tests. */
export default async function setup(project: TestProject) {
  const container = await new GenericContainer("greenmail/standalone:2.1.8")
    .withExposedPorts(3025, 3143)
    .withEnvironment({
      // User format: local-part:password[@domain]
      // IMAP login uses local-part only; SMTP delivery uses full email
      GREENMAIL_OPTS:
        "-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=testuser:testpass@localhost",
    })
    .withWaitStrategy(Wait.forLogMessage(/Starting GreenMail API server/))
    .start();

  project.provide("greenmailHost", container.getHost());
  project.provide("greenmailImapPort", container.getMappedPort(3143));
  project.provide("greenmailSmtpPort", container.getMappedPort(3025));

  return async () => {
    await container.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    greenmailHost: string;
    greenmailImapPort: number;
    greenmailSmtpPort: number;
  }
}
