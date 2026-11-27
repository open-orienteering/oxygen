import { describe, expect, it } from "vitest";
import { pickClimbField, type ClimbTerrainLike } from "../pick.js";

const lm = { id: "lantmateriet-2m", grade: "anchor" as const, attribution: "© Lantmäteriet", licence: "CC BY 4.0" };
const glo = { id: "glo30-30m", grade: "coarse" as const, attribution: "© DLR e.V." };
const contours = { state: "ready" as const, url: "/h.bin?v=1" };
const dem = (provider: typeof lm | typeof glo, state: NonNullable<ClimbTerrainLike["dem"]>["state"] = "ready") => ({ state, provider, ground: { url: "/g.bin" }, anchored: { url: "/a.bin" } });

describe("pickClimbField (course-elevation.md §3)", () => {
  it("no descriptor, no contours, over the cap: none", () => {
    expect(pickClimbField(null)).toBeNull();
    expect(pickClimbField(undefined)).toBeNull();
    expect(pickClimbField({ state: "none", url: null })).toBeNull();
    expect(pickClimbField({ state: "over-cap", url: null })).toBeNull();
  });

  it("an anchor-grade ground model first", () => {
    expect(pickClimbField({ ...contours, dem: dem(lm) })).toEqual({ url: "/g.bin", basis: "ground", provider: lm });
  });

  it("a coarse ground model is never read: the anchored contour field instead", () => {
    expect(pickClimbField({ ...contours, dem: dem(glo) })).toEqual({ url: "/a.bin", basis: "contours", provider: glo });
  });

  it("an anchor-grade DEM without a ground row: the anchored field", () => {
    expect(pickClimbField({ ...contours, dem: { ...dem(lm), ground: null } })).toEqual({ url: "/a.bin", basis: "contours", provider: lm });
  });

  it("a DEM that is not ready: the plain contour field", () => {
    for (const state of ["pending", "unavailable", "failed", "disabled"] as const) {
      expect(pickClimbField({ ...contours, dem: dem(lm, state) })).toEqual({ url: "/h.bin?v=1", basis: "contours", provider: null });
    }
    expect(pickClimbField({ ...contours, dem: null })).toEqual({ url: "/h.bin?v=1", basis: "contours", provider: null });
    expect(pickClimbField(contours)).toEqual({ url: "/h.bin?v=1", basis: "contours", provider: null });
  });

  it("a pending contour field is picked (fetching derives it)", () => {
    expect(pickClimbField({ state: "pending", url: "/h.bin?v=1" })).toEqual({ url: "/h.bin?v=1", basis: "contours", provider: null });
  });

  it("a ready DEM over a map without contours still gives its ground", () => {
    expect(pickClimbField({ state: "none", url: null, dem: dem(lm) })).toEqual({ url: "/g.bin", basis: "ground", provider: lm });
  });

  describe("the contour interval (§3, §0.43)", () => {
    const iv = (confirmedM: number | null) => ({ assumedM: 5, confirmedM });

    it("the plain contour field carries the interval to read at and whether a person confirmed it", () => {
      expect(pickClimbField({ ...contours, interval: iv(null) })).toEqual({ url: "/h.bin?v=1", basis: "contours", provider: null, interval: { m: 5, confirmed: false } });
      expect(pickClimbField({ ...contours, interval: iv(5) })).toEqual({ url: "/h.bin?v=1", basis: "contours", provider: null, interval: { m: 5, confirmed: true } });
      expect(pickClimbField({ ...contours, interval: iv(2.5) })).toEqual({ url: "/h.bin?v=1", basis: "contours", provider: null, interval: { m: 2.5, confirmed: true } });
    });

    it("a descriptor without an interval reads as unconfirmed: no interval on the pick", () => {
      expect(pickClimbField({ ...contours, interval: null })?.interval).toBeUndefined();
      expect(pickClimbField(contours)?.interval).toBeUndefined();
    });

    it("the anchored row is taken when unconfirmed or confirmed at the assumed interval, not at another", () => {
      const coarse = { ...contours, dem: dem(glo) };
      expect(pickClimbField({ ...coarse, interval: iv(null) })).toEqual({ url: "/a.bin", basis: "contours", provider: glo, interval: { m: 5, confirmed: false } });
      expect(pickClimbField({ ...coarse, interval: iv(5) })).toEqual({ url: "/a.bin", basis: "contours", provider: glo, interval: { m: 5, confirmed: true } });
      expect(pickClimbField({ ...coarse, interval: iv(2.5) })).toEqual({ url: "/h.bin?v=1", basis: "contours", provider: null, interval: { m: 2.5, confirmed: true } });
    });

    it("a ground model needs no interval", () => {
      expect(pickClimbField({ ...contours, dem: dem(lm), interval: iv(null) })).toEqual({ url: "/g.bin", basis: "ground", provider: lm });
    });
  });
});
