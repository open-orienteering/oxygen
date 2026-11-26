import { describe, expect, it } from "vitest";
import { loadLastIdentity, resolveCurrentUser, saveLastIdentity, type Identity } from "../current-user-state";

const alice: Identity = {
  authEnabled: true,
  user: { id: "u1", email: "a@example.org", displayName: "A", isAdmin: false },
  identityEmail: "a@example.org",
};

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("resolveCurrentUser (WEB-04)", () => {
  it("a failing background refetch over cached data keeps the app mounted", () => {
    const r = resolveCurrentUser({ data: alice, isLoading: false, networkClass: true, lastKnown: null });
    expect(r.isLoading).toBe(false);
    expect(r.user?.id).toBe("u1");
    expect(r.authEnabled).toBe(true);
    expect(r.degraded).toBe(true);
  });

  it("a cold start during an outage runs on the remembered identity", () => {
    const r = resolveCurrentUser({ data: undefined, isLoading: false, networkClass: true, lastKnown: alice });
    expect(r.isLoading).toBe(false);
    expect(r.user?.id).toBe("u1");
    const off = resolveCurrentUser({ data: undefined, isLoading: false, networkClass: true, lastKnown: { authEnabled: false, user: null, identityEmail: null } });
    expect(off).toMatchObject({ isLoading: false, authEnabled: false });
  });

  it("a cold start during an outage with nothing remembered waits, auth assumed on", () => {
    const r = resolveCurrentUser({ data: undefined, isLoading: false, networkClass: true, lastKnown: null });
    expect(r).toMatchObject({ isLoading: true, authEnabled: true, user: null, degraded: false });
  });

  it("the first load waits for the server, not for the remembered identity", () => {
    expect(resolveCurrentUser({ data: undefined, isLoading: true, networkClass: false, lastKnown: alice }))
      .toMatchObject({ isLoading: true, user: null });
  });

  it("a non-network error does not use the remembered identity, and auth reads as off (as before)", () => {
    expect(resolveCurrentUser({ data: undefined, isLoading: false, networkClass: false, lastKnown: alice }))
      .toMatchObject({ isLoading: false, user: null, authEnabled: false });
  });
});

describe("last identity storage", () => {
  it("round-trips and ignores junk", () => {
    const s = memory();
    expect(loadLastIdentity(s)).toBeNull();
    saveLastIdentity(alice, s);
    expect(loadLastIdentity(s)).toEqual(alice);
    s.setItem("oxygen.lastIdentity", "{not json");
    expect(loadLastIdentity(s)).toBeNull();
    s.setItem("oxygen.lastIdentity", JSON.stringify({ user: null }));
    expect(loadLastIdentity(s)).toBeNull();
  });
  it("swallows a throwing storage", () => {
    const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(loadLastIdentity(bad)).toBeNull();
    expect(() => saveLastIdentity(alice, bad)).not.toThrow();
  });
});
