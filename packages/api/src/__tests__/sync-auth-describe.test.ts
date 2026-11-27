import { describe, expect, it } from "vitest";
import { describeSyncAuth } from "../sync/googleIdToken.js";

const KEY = "/run/secrets/venue-sa.json";

describe("describeSyncAuth", () => {
  it("reports IAP off with neither variable", () => {
    const r = describeSyncAuth({}, () => true);
    expect(r.level).toBe("info");
    expect(r.message).toMatch(/IAP auth off/);
  });
  it("reports IAP on with audience and a readable key", () => {
    const r = describeSyncAuth(
      { SYNC_GOOGLE_AUDIENCE: "client.apps.googleusercontent.com", GOOGLE_APPLICATION_CREDENTIALS: KEY },
      (p) => p === KEY,
    );
    expect(r).toMatchObject({ level: "info" });
    expect(r.message).toMatch(/IAP auth on/);
  });
  it("warns when the audience is set without a key variable", () => {
    const r = describeSyncAuth({ SYNC_GOOGLE_AUDIENCE: "x" }, () => true);
    expect(r.level).toBe("warn");
    expect(r.message).toMatch(/VENUE_SA_KEY/);
  });
  it("warns when the key file is unreadable", () => {
    const r = describeSyncAuth(
      { SYNC_GOOGLE_AUDIENCE: "x", GOOGLE_APPLICATION_CREDENTIALS: KEY },
      () => false,
    );
    expect(r.level).toBe("warn");
    expect(r.message).toMatch(/unreadable/);
  });
  it("warns when the key is set without an audience", () => {
    const r = describeSyncAuth({ GOOGLE_APPLICATION_CREDENTIALS: KEY }, () => true);
    expect(r.level).toBe("warn");
    expect(r.message).toMatch(/SYNC_GOOGLE_AUDIENCE/);
  });
  it("treats blank values as unset", () => {
    expect(describeSyncAuth({ SYNC_GOOGLE_AUDIENCE: " ", GOOGLE_APPLICATION_CREDENTIALS: "" }, () => false).level).toBe("info");
  });
});
