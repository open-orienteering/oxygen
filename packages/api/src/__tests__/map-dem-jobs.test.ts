import { describe, expect, it } from "vitest";
import { DEM_JOB_RULES, demErrorText, demOverCapOf, demOverCapText, demRetryAt, isDemClaimable } from "../map-store/dem-jobs.js";
import { DEM_CAPS } from "../map-store/dem-cog.js";
import { demSourceProvider, heightfieldUrl, parseHeightfieldSource } from "../map-store/heightfield.js";

const NOW = new Date("2026-11-15T12:00:00Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);

describe("DEM job retries (map-storage.md §4.7)", () => {
  it("backs off 1 min, 10 min, 1 h, 6 h and stops after the fifth attempt", () => {
    expect([1, 2, 3, 4].map((n) => demRetryAt(n, "http", NOW))).toEqual([after(60_000), after(600_000), after(3_600_000), after(21_600_000)]);
    expect(demRetryAt(5, "http", NOW)).toBeNull();
    expect(demRetryAt(DEM_JOB_RULES.maxAttempts + 3, "timeout", NOW)).toBeNull();
  });

  it("waits at least an hour after a refused credential", () => {
    expect(demRetryAt(1, "auth", NOW)).toEqual(after(3_600_000));
    expect(demRetryAt(4, "auth", NOW)).toEqual(after(21_600_000));
  });

  it("claims queued, due failed and stale running jobs only", () => {
    expect(isDemClaimable({ state: "queued", nextAttemptAt: null, heartbeatAt: null }, NOW)).toBe(true);
    expect(isDemClaimable({ state: "queued", nextAttemptAt: after(1), heartbeatAt: null }, NOW)).toBe(false);
    expect(isDemClaimable({ state: "failed", nextAttemptAt: after(-1), heartbeatAt: null }, NOW)).toBe(true);
    expect(isDemClaimable({ state: "failed", nextAttemptAt: null, heartbeatAt: null }, NOW)).toBe(false);
    expect(isDemClaimable({ state: "running", nextAttemptAt: null, heartbeatAt: after(-DEM_JOB_RULES.staleMs - 1) }, NOW)).toBe(true);
    expect(isDemClaimable({ state: "running", nextAttemptAt: null, heartbeatAt: after(-1000) }, NOW)).toBe(false);
    for (const state of ["done", "unavailable"]) expect(isDemClaimable({ state, nextAttemptAt: after(-1), heartbeatAt: null }, NOW)).toBe(false);
  });

  it("stores a capped message without a Basic credential", () => {
    expect(demErrorText(new Error("sent Basic Y2x1Yjpub3QtcmVhbA== and got 401"))).toBe("sent Basic … and got 401");
    expect(demErrorText("x".repeat(5000))).toHaveLength(2000);
  });

  it("stores which cap an over-cap ending hit, and reads it back (map-terrain §7.0c answer 12)", () => {
    for (const cap of DEM_CAPS) {
      const text = demOverCapText(cap, "the window needs 89.2 M cells at 2 m and 22.3 M at 4 m");
      expect(text.startsWith(`${cap}: `)).toBe(true);
      expect(demOverCapOf(text)).toBe(cap);
    }
    expect(demOverCapText("tiles", `sent Basic Y2x1Yjpub3QtcmVhbA== ${"x".repeat(5000)}`)).toHaveLength(2000);
    expect(demOverCapText("tiles", "sent Basic Y2x1Yjpub3QtcmVhbA==")).not.toContain("Y2x1Yjpub3QtcmVhbA");
    for (const other of [null, "", "the window is large", "window-cells", "cells: no"]) expect(demOverCapOf(other)).toBeNull();
  });
});

describe("height sources on the route (map-storage.md §4.7 \"Contract\")", () => {
  it("parses contours, the DEM forms, and nothing else", () => {
    expect(parseHeightfieldSource(undefined)).toBe("contours");
    expect(parseHeightfieldSource("contours")).toBe("contours");
    expect(parseHeightfieldSource("ground.lantmateriet-2m")).toBe("ground.lantmateriet-2m");
    expect(parseHeightfieldSource("contours.glo30-30m")).toBe("contours.glo30-30m");
    for (const bad of ["", "ground", "GROUND.x", "dem.x-1m", ["ground.x"], 3]) expect(parseHeightfieldSource(bad)).toBeNull();
    expect(demSourceProvider("ground.lantmateriet-2m")).toBe("lantmateriet-2m");
    expect(demSourceProvider("contours")).toBeNull();
  });

  it("puts the source in the URL for a DEM field only", () => {
    expect(heightfieldUrl("a".repeat(64), 1)).toBe(`/api/map-documents/${"a".repeat(64)}/height.bin?v=1`);
    expect(heightfieldUrl("a".repeat(64), 1, "ground.lantmateriet-2m")).toBe(`/api/map-documents/${"a".repeat(64)}/height.bin?v=1&source=ground.lantmateriet-2m`);
  });
});
