import { describe, it, expect } from "vitest";
import {
  ALL_CAPABILITIES,
  effectiveCapabilities,
  isEventCompleted,
} from "../permissions.js";
import type { AuthUser } from "../auth.js";

const member: AuthUser = {
  id: "u1",
  email: "m@x.se",
  displayName: "M",
  isAdmin: false,
  active: true,
};

const admin: AuthUser = { ...member, id: "a1", isAdmin: true };

describe("effectiveCapabilities", () => {
  it("returns every capability when auth is off", () => {
    expect(
      effectiveCapabilities({
        user: null,
        grants: [],
        eventCompleted: false,
        authEnabled: false,
      }),
    ).toEqual(new Set(ALL_CAPABILITIES));
  });

  it("returns none when there is no user and auth is on", () => {
    expect(
      effectiveCapabilities({
        user: null,
        grants: [],
        eventCompleted: true,
        authEnabled: true,
      }),
    ).toEqual(new Set());
  });

  it("returns every capability for an instance admin", () => {
    expect(
      effectiveCapabilities({
        user: admin,
        grants: [],
        eventCompleted: false,
        authEnabled: true,
      }),
    ).toEqual(new Set(ALL_CAPABILITIES));
  });

  it("unions a single grant group", () => {
    expect(
      effectiveCapabilities({
        user: member,
        grants: [["event.view", "results.view"]],
        eventCompleted: false,
        authEnabled: true,
      }),
    ).toEqual(new Set(["event.view", "results.view"]));
  });

  it("unions multiple grant groups", () => {
    expect(
      effectiveCapabilities({
        user: member,
        grants: [
          ["event.view", "courses.view"],
          ["event.view", "race.operate"],
        ],
        eventCompleted: false,
        authEnabled: true,
      }),
    ).toEqual(new Set(["event.view", "courses.view", "race.operate"]));
  });

  it("adds view capabilities after the race for a plain member", () => {
    expect(
      effectiveCapabilities({
        user: member,
        grants: [["event.view", "results.view"]],
        eventCompleted: true,
        authEnabled: true,
      }),
    ).toEqual(new Set(["event.view", "results.view", "courses.view"]));
  });

  it("does not add mutate capabilities after the race", () => {
    const caps = effectiveCapabilities({
      user: member,
      grants: [["event.view", "results.view"]],
      eventCompleted: true,
      authEnabled: true,
    });
    expect(caps.has("courses.edit")).toBe(false);
    expect(caps.has("event.manage")).toBe(false);
    expect(caps.has("race.operate")).toBe(false);
  });
});

describe("isEventCompleted", () => {
  it("treats a past date with no results as completed", () => {
    expect(isEventCompleted("2020-01-01", 0)).toBe(true);
  });

  it("treats today with results as completed", () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(isEventCompleted(today, 1)).toBe(true);
    expect(isEventCompleted(today, 0)).toBe(false);
  });

  it("treats a future date with no results as not completed", () => {
    expect(isEventCompleted("2099-12-31", 0)).toBe(false);
  });
});
