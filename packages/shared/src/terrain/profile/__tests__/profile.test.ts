import { describe, expect, it } from "vitest";
import { gridField } from "../../field/__tests__/fixtures.js";
import { Z_PER_INTERVAL } from "../../field/types.js";
import { courseProfile, distanceAtPoint, pointAtDistance, profileAlong, profileStepM } from "../profile.js";
import { fieldSampler } from "../sampler.js";
import type { TerrainSampler } from "../types.js";

/** Height units per metre in the fixtures (5 m interval). */
const U = Z_PER_INTERVAL / 5;
/** A plane rising 1 m per cell east; 0.2 mm cells at 15 m/mm = 3 m cells. */
const slope = () => gridField(200, 50, (cx) => cx * U);
/** Paper mm of a cell centre. */
const c = (cx: number, cy: number) => ({ x: (cx + 0.5) * 0.2, y: (cy + 0.5) * 0.2 });

/** An analytic sampler: 1 mm = 10 m, 2 m cells. */
const analytic = (z: (x: number, y: number) => number | null, confident: (x: number) => boolean = () => true): TerrainSampler => ({
  heightAt: (p) => z(p.x, p.y),
  confidentAt: (p) => confident(p.x),
  groundMPerMm: 10,
  cellM: 2,
  datum: "relative",
  source: "contours",
});

describe("fieldSampler (course-elevation.md §1)", () => {
  it("carries the field's scale, cell, datum, source and provider", () => {
    const f = slope();
    const s = fieldSampler(f);
    expect(s.groundMPerMm).toBe(15);
    expect(s.cellM).toBeCloseTo(3, 9);
    expect(s.datum).toBe("relative");
    expect(s.source).toBe("contours");
    expect(s.provider).toBeUndefined();
    expect(s.heightAt(c(10, 5))).toBeCloseTo(10, 6);
    expect(s.heightAt({ x: -1, y: 0 })).toBeNull();
    expect(s.confidentAt(c(10, 5))).toBe(true);
    const provider = { id: "lantmateriet-2m", resolutionM: 2, grade: "anchor" as const, licence: "CC BY 4.0", attribution: "© Lantmäteriet", verticalDatum: "RH 2000" };
    const g = fieldSampler({ ...f, header: { ...f.header, source: "ground.lantmateriet-2m", datum: "absolute", provider } });
    expect(g.datum).toBe("absolute");
    expect(g.source).toBe("ground.lantmateriet-2m");
    expect(g.provider).toEqual(provider);
  });
});

describe("fieldSampler at a confirmed interval (course-elevation.md §3, §0.43)", () => {
  const A = { x: 0.1, y: 5 }, B = { x: 30, y: 5 };
  it("a relative field read at 2.5 m instead of 5 m gives half the heights and, on a ramp, half the climb", () => {
    const f = slope();
    const at5 = courseProfile([{ points: [A, B] }], fieldSampler(f));
    const at25 = courseProfile([{ points: [A, B] }], fieldSampler(f, { intervalM: 2.5 }));
    expect(fieldSampler(f, { intervalM: 2.5 }).heightAt(c(10, 5))!).toBeCloseTo(fieldSampler(f).heightAt(c(10, 5))! / 2, 6);
    expect(at5.climbM).toBeGreaterThan(10);
    expect(at25.climbM).toBeCloseTo(at5.climbM / 2, 1);
    // The interval it was derived at, or none: untouched.
    expect(fieldSampler(f, { intervalM: 5 }).heightAt(c(10, 5))).toBe(fieldSampler(f).heightAt(c(10, 5)));
  });

  it("an absolute field ignores the option", () => {
    const f = slope();
    const abs = { ...f, header: { ...f.header, datum: "absolute" as const } };
    expect(fieldSampler(abs, { intervalM: 2.5 }).heightAt(c(10, 5))).toBe(fieldSampler(abs).heightAt(c(10, 5)));
  });
});

describe("profileAlong (course-elevation.md §1)", () => {
  it("the default step is half a cell, at least 1 m", () => {
    expect(profileStepM({ cellM: 6 })).toBe(3);
    expect(profileStepM({ cellM: 3 })).toBe(1.5);
    expect(profileStepM({ cellM: 0.8 })).toBe(1);
  });

  it("samples both ends and equal steps no longer than the step", () => {
    const p = profileAlong([{ x: 0, y: 0 }, { x: 1, y: 0 }], analytic(() => 0)); // 10 m, step 1 m
    expect(p.lengthM).toBeCloseTo(10, 9);
    expect(p.samples).toHaveLength(11);
    expect(p.samples[0].dM).toBe(0);
    expect(p.samples[10].dM).toBeCloseTo(10, 9);
    const q = profileAlong([{ x: 0, y: 0 }, { x: 1.05, y: 0 }], analytic(() => 0)); // 10.5 m → 11 steps
    expect(q.samples).toHaveLength(12);
    expect(q.samples[1].dM).toBeCloseTo(10.5 / 11, 9);
  });

  it("a vertex is sampled once and distance runs along the polyline", () => {
    const p = profileAlong([{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.4 }], analytic((x, y) => x + y), { stepM: 1 });
    expect(p.lengthM).toBeCloseTo(7, 9);
    expect(p.samples.map((s) => +s.dM.toFixed(6))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(p.samples[3].zM).toBeCloseTo(0.3, 9);
    expect(p.samples[7].zM).toBeCloseTo(0.7, 9);
  });

  it("climb, descent and net on a field: up a slope and back", () => {
    const s = fieldSampler(slope());
    const up = profileAlong([c(10, 10), c(110, 10)], s);
    expect(up.lengthM).toBeCloseTo(300, 6);
    expect(up.climbM).toBeCloseTo(100, 1);
    expect(up.descentM).toBe(0);
    expect(up.netM).toBeCloseTo(100, 1);
    expect(up.coverage).toBeCloseTo(1, 9);
    expect(up.confidence).toBeCloseTo(1, 9);
    const back = profileAlong([c(10, 10), c(110, 10), c(60, 10)], s);
    expect(back.climbM).toBeCloseTo(100, 1);
    expect(back.descentM).toBeCloseTo(50, 1);
    expect(back.netM).toBeCloseTo(50, 1);
  });

  it("along a contour there is no climb", () => {
    const p = profileAlong([c(50, 5), c(50, 45)], fieldSampler(slope()));
    expect(p.climbM).toBe(0);
    expect(p.descentM).toBe(0);
    expect(p.netM).toBeCloseTo(0, 9);
  });

  it("does not depend on the step", () => {
    const s = analytic((x) => 12 * Math.sin(x / 4) + x);
    const pts = [{ x: 0, y: 0 }, { x: 60, y: 0 }];
    const fine = profileAlong(pts, s, { stepM: 0.5 }).climbM;
    for (const stepM of [1, 2, 4]) expect(Math.abs(profileAlong(pts, s, { stepM }).climbM - fine)).toBeLessThan(0.01 * fine);
  });

  it("coverage and confidence are shares of length", () => {
    // 100 m; no data for x in (4, 6] mm; not confident beyond 8 mm
    const s = analytic((x) => (x > 4 && x <= 6 ? null : 0), (x) => x <= 8);
    const p = profileAlong([{ x: 0, y: 0 }, { x: 10, y: 0 }], s);
    expect(Math.abs(p.coverage - 0.8)).toBeLessThan(0.011); // within one 1 m sample of 100 m
    expect(Math.abs(p.confidence - 0.6)).toBeLessThan(0.011);
    expect(p.samples.find((x) => x.zM === null)?.confident).toBe(false);
  });

  it("a gap is skipped: the heights on either side follow each other", () => {
    const s = analytic((x) => (x > 4 && x < 6 ? null : x < 5 ? 0 : 7));
    const p = profileAlong([{ x: 0, y: 0 }, { x: 10, y: 0 }], s);
    expect(p.climbM).toBe(7);
    expect(p.netM).toBe(7);
  });

  it("net is null unless both ends have data", () => {
    const s = analytic((x) => (x < 1 ? null : x));
    expect(profileAlong([{ x: 0, y: 0 }, { x: 10, y: 0 }], s).netM).toBeNull();
    expect(profileAlong([{ x: 2, y: 0 }, { x: 10, y: 0 }], s).netM).toBeCloseTo(8, 9);
  });

  it("no data at all: no climb, null net, zero shares", () => {
    const p = profileAlong([{ x: 0, y: 0 }, { x: 1, y: 0 }], analytic(() => null));
    expect(p).toMatchObject({ climbM: 0, descentM: 0, netM: null, coverage: 0, confidence: 0 });
    expect(p.lengthM).toBeCloseTo(10, 9);
  });

  it("degenerate polylines have no samples", () => {
    const s = analytic(() => 1);
    for (const pts of [[], [{ x: 1, y: 1 }], [{ x: 1, y: 1 }, { x: 1, y: 1 }]]) {
      expect(profileAlong(pts, s)).toEqual({ lengthM: 0, samples: [], climbM: 0, descentM: 0, netM: null, coverage: 0, confidence: 0 });
    }
  });

  it("a repeated point inside a polyline is not sampled twice", () => {
    const p = profileAlong([{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 0.2, y: 0 }, { x: 0.4, y: 0 }], analytic(() => 0), { stepM: 1 });
    expect(p.samples.map((s) => +s.dM.toFixed(6))).toEqual([0, 1, 2, 3, 4]);
  });

  it("the threshold option reaches the climb", () => {
    const s = analytic((x) => 0.75 * (1 - Math.cos(x * Math.PI))); // 1.5 m bumps every 20 m
    const pts = [{ x: 0, y: 0 }, { x: 8, y: 0 }];
    expect(profileAlong(pts, s).climbM).toBeCloseTo(6, 1);
    expect(profileAlong(pts, s, { thresholdM: 2 }).climbM).toBe(0);
  });
});

describe("courseProfile (course-elevation.md §2 'A course')", () => {
  const s = fieldSampler(slope());

  it("legs in order with offsets; totals are the sums", () => {
    const course = courseProfile([{ points: [c(10, 10), c(60, 10)] }, { points: [c(60, 10), c(60, 40)] }, { points: [c(60, 40), c(30, 40)] }], s);
    expect(course.legs.map((l) => Math.round(l.offsetM))).toEqual([0, 150, 240]);
    expect(course.lengthM).toBeCloseTo(330, 6);
    expect(course.legs.map((l) => Math.round(l.climbM ?? -1))).toEqual([50, 0, 0]);
    expect(course.legs.map((l) => Math.round(l.descentM ?? -1))).toEqual([0, 0, 30]);
    expect(course.climbM).toBeCloseTo(50, 1);
    expect(course.descentM).toBeCloseTo(30, 1);
    expect(course.partial).toBe(false);
    expect(course.coverage).toBeCloseTo(1, 9);
  });

  it("a rise is carried across a control: gentle legs add up, and the legs' shares sum to the total", () => {
    const gentle = fieldSampler(gridField(200, 20, (cx) => cx * 0.05 * U)); // 0.05 m per 3 m cell
    const legs = Array.from({ length: 5 }, (_, i) => ({ points: [c(10 + i * 15, 5), c(25 + i * 15, 5)] })); // 0.75 m each
    const course = courseProfile(legs, gentle);
    expect(course.climbM).toBeCloseTo(3.75, 1);
    expect(course.climbM).toBeCloseTo(profileAlong([c(10, 5), c(85, 5)], gentle).climbM, 6);
    for (const leg of course.legs) expect(leg.climbM).toBeCloseTo(0.75, 1);
    expect(course.legs.reduce((a, l) => a + (l.climbM ?? 0), 0)).toBeCloseTo(course.climbM, 9);
    // a single such leg on its own is under the threshold
    expect(profileAlong(legs[0].points, gentle).climbM).toBe(0);
  });

  it("shares are never negative and sum to the total over a hill with dips", () => {
    const bumpy = fieldSampler(gridField(200, 20, (cx) => (cx * 0.3 + 0.4 * Math.sin(cx)) * U));
    const legs = [10, 37, 41, 90, 120].map((a, i, xs) => ({ points: [c(a, 5), c(xs[i + 1] ?? 150, 5)] }));
    const course = courseProfile(legs, bumpy);
    for (const leg of course.legs) expect(leg.climbM).toBeGreaterThanOrEqual(0);
    expect(course.legs.reduce((a, l) => a + (l.climbM ?? 0), 0)).toBeCloseTo(course.climbM, 9);
    expect(course.legs.reduce((a, l) => a + (l.descentM ?? 0), 0)).toBeCloseTo(course.descentM, 9);
    expect(course.climbM).toBeCloseTo(profileAlong([c(10, 5), c(150, 5)], bumpy).climbM, 6);
  });

  it("a leg without data has null climb and makes the course partial", () => {
    const course = courseProfile([{ points: [c(10, 10), c(60, 10)] }, { points: [{ x: 500, y: 500 }, { x: 510, y: 500 }] }], s);
    expect(course.legs[1].climbM).toBeNull();
    expect(course.legs[1].descentM).toBeNull();
    expect(course.partial).toBe(true);
    expect(course.legs[0].climbM).toBeCloseTo(50, 1);
    expect(course.climbM).toBeCloseTo(50, 1);
    expect(course.coverage).toBeCloseTo(150 / 300, 6);
  });

  it("no legs", () => {
    expect(courseProfile([], s)).toEqual({ legs: [], lengthM: 0, climbM: 0, descentM: 0, coverage: 0, confidence: 0, partial: false });
  });
});

describe("pointAtDistance / distanceAtPoint (course-elevation.md §1)", () => {
  const line = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }];

  it("the point a distance along, clamped to the ends", () => {
    expect(pointAtDistance(line, 10, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAtDistance(line, 10, 20)).toEqual({ x: 2, y: 0 });
    expect(pointAtDistance(line, 10, 50)).toEqual({ x: 3, y: 2 });
    expect(pointAtDistance(line, 10, 999)).toEqual({ x: 3, y: 4 });
    expect(pointAtDistance(line, 10, -5)).toEqual({ x: 0, y: 0 });
    expect(pointAtDistance([{ x: 1, y: 1 }], 10, 0)).toBeNull();
  });

  it("the nearest place on the polyline and how far off the point is", () => {
    expect(distanceAtPoint(line, 10, { x: 1, y: 0.5 })).toEqual({ dM: 10, offMm: 0.5 });
    const d = distanceAtPoint(line, 10, { x: 4, y: 3 });
    expect(d?.dM).toBeCloseTo(60, 9);
    expect(d?.offMm).toBeCloseTo(1, 9);
    expect(distanceAtPoint([], 10, { x: 0, y: 0 })).toBeNull();
  });

  it("they invert each other on the line", () => {
    for (const dM of [0, 7, 30, 44, 70]) expect(distanceAtPoint(line, 10, pointAtDistance(line, 10, dM)!)?.dM).toBeCloseTo(dM, 9);
  });
});
