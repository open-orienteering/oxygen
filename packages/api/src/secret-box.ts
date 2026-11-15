/**
 * Sealing a small secret for a settings row (docs/map-terrain.md §7.8
 * "Sealing"): AES-256-GCM, a random 12-byte IV per seal, the row's key as
 * additional data (a sealed value moved to another row does not open),
 * stored as `v1:<iv>:<tag>:<ciphertext>` in base64.
 *
 * The key is 32 bytes the caller supplies; where it lives is the caller's
 * (for the DEM account, a row beside it: map-terrain §7.0b answer 10).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
export const SECRET_KEY_BYTES = 32;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

function checkKey(key: Uint8Array): void {
  if (key.byteLength !== SECRET_KEY_BYTES) throw new SecretBoxError(`the sealing key must be ${SECRET_KEY_BYTES} bytes`);
}

/** A fresh random key. */
export function newSecretKey(): Buffer {
  return randomBytes(SECRET_KEY_BYTES);
}

export function seal(plaintext: string, key: Uint8Array, aad: string): string {
  checkKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

/** Opens a sealed value; throws `SecretBoxError` on a wrong key, another row's value, tampering or a malformed value. */
export function open(sealed: string, key: Uint8Array, aad: string): string {
  checkKey(key);
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError("not a sealed value");
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64"), tag = Buffer.from(tagB64, "base64"), ct = Buffer.from(ctB64, "base64");
  if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new SecretBoxError("not a sealed value");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError("the sealed value does not open with this key");
  }
}
