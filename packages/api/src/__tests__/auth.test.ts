import { describe, it, expect, afterEach } from "vitest";
import {
  parseIdentityEmail,
  parseOxygenAdminEmails,
  authMode,
  authHeaderName,
} from "../auth.js";

describe("parseIdentityEmail", () => {
  it("returns a trimmed lowercase email", () => {
    expect(parseIdentityEmail("  Alice@Example.SE  ")).toBe("alice@example.se");
  });

  it("strips a GCP IAP issuer prefix after the last colon", () => {
    expect(parseIdentityEmail("accounts.google.com:user@example.se")).toBe(
      "user@example.se",
    );
  });

  it("uses the first value when the header is an array", () => {
    expect(parseIdentityEmail(["Bob@Club.se", "other@x.com"])).toBe(
      "bob@club.se",
    );
  });

  it("returns null for missing, empty, or garbage values", () => {
    expect(parseIdentityEmail(undefined)).toBeNull();
    expect(parseIdentityEmail("")).toBeNull();
    expect(parseIdentityEmail("   ")).toBeNull();
    expect(parseIdentityEmail("not-an-email")).toBeNull();
    expect(parseIdentityEmail("foo@")).toBeNull();
    expect(parseIdentityEmail("@bar.com")).toBeNull();
    expect(parseIdentityEmail("a@b c")).toBeNull();
  });
});

describe("parseOxygenAdminEmails", () => {
  const original = process.env.OXYGEN_ADMIN_EMAILS;

  afterEach(() => {
    if (original === undefined) delete process.env.OXYGEN_ADMIN_EMAILS;
    else process.env.OXYGEN_ADMIN_EMAILS = original;
  });

  it("splits on commas, trims, and lowercases", () => {
    process.env.OXYGEN_ADMIN_EMAILS = " Ada@Club.se , bob@club.se ";
    expect(parseOxygenAdminEmails()).toEqual(["ada@club.se", "bob@club.se"]);
  });

  it("drops empty and invalid entries", () => {
    process.env.OXYGEN_ADMIN_EMAILS = "ok@x.se,,not-email,  ";
    expect(parseOxygenAdminEmails()).toEqual(["ok@x.se"]);
  });

  it("returns an empty list when unset", () => {
    delete process.env.OXYGEN_ADMIN_EMAILS;
    expect(parseOxygenAdminEmails()).toEqual([]);
  });
});

describe("auth env accessors", () => {
  const keys = ["AUTH_MODE", "AUTH_HEADER"] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults AUTH_MODE to off and AUTH_HEADER to x-forwarded-email", () => {
    for (const k of keys) saved[k] = process.env[k];
    delete process.env.AUTH_MODE;
    delete process.env.AUTH_HEADER;
    expect(authMode()).toBe("off");
    expect(authHeaderName()).toBe("x-forwarded-email");
  });

  it("normalizes AUTH_MODE and lowercases the header name", () => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.AUTH_MODE = "PROXY";
    process.env.AUTH_HEADER = "X-Goog-Authenticated-User-Email";
    expect(authMode()).toBe("proxy");
    expect(authHeaderName()).toBe("x-goog-authenticated-user-email");
  });
});
