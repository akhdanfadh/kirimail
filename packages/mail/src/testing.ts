/**
 * Test utilities for IMAP operations. Intended for use by other packages'
 * integration tests - not part of the production API.
 *
 * Usage: import { seedMessage, testCredentials } from "@kirimail/mail/testing"
 */
export type { SeedMessageHeaders, SeedMessageOptions } from "./__tests__/setup";
export { testCredentials, seedMessage } from "./__tests__/setup";
export { withImapConnection } from "./connection";
