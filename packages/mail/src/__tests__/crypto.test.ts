import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decryptCredential,
  deserializeEnvelope,
  encryptCredential,
  serializeEnvelope,
} from "../crypto";

const TEST_KEY = randomBytes(32);
const KEY_VERSION = 1;

describe("crypto", () => {
  it("encrypts and decrypts back to the original plaintext", () => {
    const plaintext = "my-secret-imap-password";
    const envelope = encryptCredential(plaintext, TEST_KEY, KEY_VERSION);
    const result = decryptCredential(envelope, TEST_KEY);
    expect(result).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const plaintext = "same-password";
    const a = encryptCredential(plaintext, TEST_KEY, KEY_VERSION);
    const b = encryptCredential(plaintext, TEST_KEY, KEY_VERSION);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("throws when decrypting with the wrong key", () => {
    const envelope = encryptCredential("secret", TEST_KEY, KEY_VERSION);
    const wrongKey = randomBytes(32);
    expect(() => decryptCredential(envelope, wrongKey)).toThrow();
  });

  it("round-trips through serialize and deserialize", () => {
    const envelope = encryptCredential("secret", TEST_KEY, KEY_VERSION);
    const serialized = serializeEnvelope(envelope);
    const deserialized = deserializeEnvelope(serialized);

    expect(deserialized).toEqual(envelope);
    expect(decryptCredential(deserialized, TEST_KEY)).toBe("secret");
  });
});
