/**
 * AES-256-GCM authenticated encryption for IMAP credentials stored at rest.
 *
 * Credentials are encrypted reversibly because the plaintext password must be
 * presented to IMAP servers on each connection. AES-GCM provides both
 * confidentiality and integrity via its auth tag.
 *
 * @see https://csrc.nist.gov/pubs/sp/800/38/d/final - NIST GCM specification
 * @see https://nodejs.org/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options - Node.js cipher API
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { CredentialEnvelope } from "./types";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Encrypt a plaintext credential with AES-256-GCM. */
export function encryptCredential(
  plaintext: string,
  key: Buffer,
  keyVersion: number,
): CredentialEnvelope {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion,
  };
}

/** Decrypt an AES-256-GCM encrypted envelope back to plaintext. */
export function decryptCredential(envelope: CredentialEnvelope, key: Buffer): string {
  const iv = Buffer.from(envelope.iv, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const authTag = Buffer.from(envelope.authTag, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

/** Serialize an encrypted envelope to a JSON string for DB storage. */
export function serializeEnvelope(envelope: CredentialEnvelope): string {
  return JSON.stringify(envelope);
}

/** Deserialize a JSON string from DB back to an encrypted envelope. */
export function deserializeEnvelope(serialized: string): CredentialEnvelope {
  return JSON.parse(serialized) as CredentialEnvelope;
}
