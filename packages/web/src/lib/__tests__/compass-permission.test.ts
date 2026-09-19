import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  COMPASS_GRANT_KEY,
  compassGrantRemembered,
  forgetCompassGrant,
  initialCompassPermission,
  rememberCompassGrant,
} from "../compass-permission";

describe("initialCompassPermission", () => {
  it("is denied when the platform has no orientation API at all", () => {
    expect(initialCompassPermission({ supported: false, needsPermission: false }, false)).toBe(
      "denied",
    );
    // A remembered grant cannot resurrect a missing API.
    expect(initialCompassPermission({ supported: false, needsPermission: true }, true)).toBe(
      "denied",
    );
  });

  it("needs no permission on Android / desktop", () => {
    expect(initialCompassPermission({ supported: true, needsPermission: false }, false)).toBe(
      "not-needed",
    );
    expect(initialCompassPermission({ supported: true, needsPermission: false }, true)).toBe(
      "not-needed",
    );
  });

  it("prompts on iOS when nothing was granted before", () => {
    expect(initialCompassPermission({ supported: true, needsPermission: true }, false)).toBe(
      "prompt",
    );
  });

  it("restores silently on iOS when a grant is remembered", () => {
    // "restoring" keeps the tap target hidden while we re-request without a
    // gesture — that call succeeds silently as long as iOS still holds the
    // grant, so the user sees a live needle instead of a button.
    expect(initialCompassPermission({ supported: true, needsPermission: true }, true)).toBe(
      "restoring",
    );
  });
});

describe("compass grant memo", () => {
  // The lib test environment is node — provide a minimal localStorage.
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("round-trips through localStorage", () => {
    expect(compassGrantRemembered()).toBe(false);
    rememberCompassGrant();
    expect(store.get(COMPASS_GRANT_KEY)).toBe("1");
    expect(compassGrantRemembered()).toBe(true);
    forgetCompassGrant();
    expect(compassGrantRemembered()).toBe(false);
    expect(store.has(COMPASS_GRANT_KEY)).toBe(false);
  });

  it("ignores a stale value that is not the current marker", () => {
    store.set(COMPASS_GRANT_KEY, "granted");
    expect(compassGrantRemembered()).toBe(false);
  });

  it("survives localStorage throwing (Safari private mode)", () => {
    const boom = () => {
      throw new Error("denied");
    };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
    };

    expect(compassGrantRemembered()).toBe(false);
    expect(() => rememberCompassGrant()).not.toThrow();
    expect(() => forgetCompassGrant()).not.toThrow();
  });
});
