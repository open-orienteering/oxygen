import { describe, expect, it } from "vitest";
import { newSecretKey, open, seal, SecretBoxError } from "../secret-box.js";

const AAD = "map_dem.lantmateriet_account";
const SECRET = "test-password-not-real";

describe("secret box (map-terrain.md §7.8 \"Sealing\")", () => {
  it("round-trips, with a different IV on every seal", () => {
    const key = newSecretKey();
    const a = seal(SECRET, key, AAD), b = seal(SECRET, key, AAD);
    expect(a).not.toBe(b);
    expect(a.split(":")[0]).toBe("v1");
    expect(open(a, key, AAD)).toBe(SECRET);
    expect(open(b, key, AAD)).toBe(SECRET);
    expect(open(seal("åäö: ∆", key, AAD), key, AAD)).toBe("åäö: ∆");
  });

  it("holds neither the plaintext nor its base64", () => {
    const sealed = seal(SECRET, newSecretKey(), AAD);
    expect(sealed).not.toContain(SECRET);
    expect(sealed).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect(sealed).not.toContain(Buffer.from(`test-user:${SECRET}`).toString("base64"));
  });

  it("refuses a wrong key, another row, tampering and a malformed value", () => {
    const key = newSecretKey();
    const sealed = seal(SECRET, key, AAD);
    expect(() => open(sealed, newSecretKey(), AAD)).toThrow(SecretBoxError);
    expect(() => open(sealed, key, "eventor_api_key")).toThrow(SecretBoxError);
    const [v, iv, tag, ct] = sealed.split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 1;
    expect(() => open([v, iv, tag, flipped.toString("base64")].join(":"), key, AAD)).toThrow(SecretBoxError);
    expect(() => open("plain-text", key, AAD)).toThrow(SecretBoxError);
    expect(() => open(`v2:${iv}:${tag}:${ct}`, key, AAD)).toThrow(SecretBoxError);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => seal(SECRET, new Uint8Array(16), AAD)).toThrow(SecretBoxError);
    expect(() => open(seal(SECRET, newSecretKey(), AAD), new Uint8Array(0), AAD)).toThrow(SecretBoxError);
  });

  it("never puts the secret in an error message", () => {
    try {
      open(seal(SECRET, newSecretKey(), AAD), newSecretKey(), AAD);
    } catch (err) {
      expect(String(err)).not.toContain(SECRET);
    }
  });
});
