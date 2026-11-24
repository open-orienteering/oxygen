import { describe, expect, it } from "vitest";
import type { CourseProfile, PolylineProfile } from "@oxygen/shared/src/terrain/profile/index.js";
import { legElevation, lineClimbStatus, sequenceLegClimbs, shownM, type CourseElevation } from "../elevation";

const leg = (over: Partial<PolylineProfile> = {}): PolylineProfile => ({ lengthM: 400, samples: [], climbM: 12.4, descentM: 3.6, netM: 8.8, coverage: 1, confidence: 1, ...over });
const profile = (over: Partial<CourseProfile> = {}): CourseProfile => ({
  legs: [{ offsetM: 0, profile: leg(), climbM: 12.4, descentM: 3.6 }, { offsetM: 400, profile: leg({ lengthM: 600.4, netM: -0.2 }), climbM: 30.2, descentM: 31 }],
  lengthM: 1000.4, climbM: 42.6, descentM: 34.6, coverage: 1, confidence: 1, partial: false, ...over,
});
const ready = (p = profile(), over: Partial<Extract<CourseElevation, { state: "ready" }>> = {}): CourseElevation => ({ state: "ready", profile: p, basis: "ground", attribution: "© Lantmäteriet", datum: "absolute", groundMPerMm: 15, ...over });

describe("the line climb of the course-info rows (docs/course-elevation.md §4)", () => {
  it("nothing without a field; loading and unavailable pass through", () => {
    expect(lineClimbStatus({ state: "none" })).toBeNull();
    expect(lineClimbStatus({ state: "loading" })).toEqual({ state: "loading" });
    expect(lineClimbStatus({ state: "unavailable", kind: "offline" })).toEqual({ state: "unavailable", kind: "offline" });
  });

  it("ready: metres rounded once, the share of length to one decimal, the basis and attribution", () => {
    expect(lineClimbStatus(ready())).toEqual({ state: "ready", climbM: 43, descentM: 35, sharePct: 4.3, basis: "ground", partial: false, approx: false, attribution: "© Lantmäteriet" });
  });

  it("approximate when partial or when under 80 % of the length is confident", () => {
    expect(lineClimbStatus(ready(profile({ partial: true })))).toMatchObject({ partial: true, approx: true });
    expect(lineClimbStatus(ready(profile({ confidence: 0.79 })))).toMatchObject({ partial: false, approx: true });
    expect(lineClimbStatus(ready(profile({ confidence: 0.8 })))).toMatchObject({ approx: false });
  });

  it("a course without length or without any data shows nothing", () => {
    expect(lineClimbStatus(ready(profile({ lengthM: 0, legs: [] })))).toBeNull();
    expect(lineClimbStatus(ready(profile({ coverage: 0 })))).toBeNull();
  });

  it("a rounded value is never -0", () => {
    expect(Object.is(shownM(-0.4), 0)).toBe(true);
    expect(shownM(-0.6)).toBe(-1);
  });
});

describe("the selected leg's numbers (docs/course-elevation.md §4.5)", () => {
  it("length, the leg's share of climb and descent, the net", () => {
    expect(legElevation(ready(), 1)).toEqual({ lengthM: 600, climbM: 30, descentM: 31, netM: 0, basis: "ground", approx: false, routed: false });
    expect(Object.is(legElevation(ready(), 1)?.netM, 0)).toBe(true);
  });

  it("a leg without data: nulls, approximate", () => {
    const p = profile();
    p.legs[0] = { offsetM: 0, profile: leg({ coverage: 0, confidence: 0, netM: null }), climbM: null, descentM: null };
    expect(legElevation(ready(p), 0)).toEqual({ lengthM: 400, climbM: null, descentM: null, netM: null, basis: "ground", approx: true, routed: false });
  });

  it("none unless ready and the leg exists", () => {
    expect(legElevation({ state: "loading" }, 0)).toBeNull();
    expect(legElevation(ready(), null)).toBeNull();
    expect(legElevation(ready(), 7)).toBeNull();
  });
});

describe("the climb of the leg into each row of the sequence (docs/course-elevation.md §4.5)", () => {
  const pt = { x: 1, y: 1 };
  it("leg k runs into the (k + 1)-th positioned row; unpositioned rows and the first have none", () => {
    const rows = [{ pt }, { pt: null }, { pt }, { pt }];
    expect(sequenceLegClimbs(rows, ready())).toEqual([null, null, { m: 12, approx: false }, { m: 30, approx: false }]);
  });

  it("a leg without data is a dash, a thin one approximate; nothing while heights are not read", () => {
    const p = profile();
    p.legs[0] = { ...p.legs[0], climbM: null, profile: leg({ coverage: 0.5 }) };
    expect(sequenceLegClimbs([{ pt }, { pt }, { pt }], ready(p))).toEqual([null, { m: null, approx: true }, { m: 30, approx: false }]);
    expect(sequenceLegClimbs([{ pt }, { pt }], { state: "loading" })).toEqual([null, null]);
    expect(sequenceLegClimbs([{ pt }, { pt }], { state: "none" })).toEqual([null, null]);
  });
});
