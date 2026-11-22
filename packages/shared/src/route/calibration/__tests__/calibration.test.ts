/**
 * The cost model calibrated from GPS tracks (docs/course-elevation.md
 * §7.9): the record, the legs, the attribution, the fit, the validation
 * and the report — on made-up terrain and made-up runners.
 */

import { describe, expect, it } from "vitest";
import { TrackProjectionError } from "../../../gps-track/project.js";
import { CLASS_INDEX, COST_CLASSES, DEFAULT_COST_MODEL, DEFAULT_COST_MODEL_DATA, costModelFromData } from "../../cost-model.js";
import { routeCost } from "../../alternatives.js";
import { buildRouteGrid, type RoutePoint } from "../../grid.js";
import { legGridCovering, legWindow } from "../../leg.js";
import {
  attributeLeg, buildReport, calibrationReportSchema, crossValidate, factorsOf, featuresCost, finderRatios, fitCostModel, foldsOf, modelDataOf, observeRecord,
  projectRecord, solveLinear, splitTrack, trackRecordSchema, type PaperControl, type PaperTrack,
} from "../index.js";
import { LOOP, TRUTH, frame, map, record, run } from "./world.js";
import { seeded } from "../fit.js";

const C = CLASS_INDEX;

describe("the track record (§7.9.1)", () => {
  it("parses the neutral shape, extra keys dropped, `kept` read as `tracks`", () => {
    const raw = { ...record(2, { key: "kept" }), eventName: "x", stats: { a: 1 } };
    const parsed = trackRecordSchema.parse(raw);
    expect("eventName" in parsed).toBe(false);
    const projected = projectRecord(frame, map().bounds, parsed);
    expect(projected.tracks).toHaveLength(2);
    expect(projected.courses.get("1")).toHaveLength(LOOP.length);
    expect(projected.warnings).toEqual([]);
  });

  it("controls and tracks land on the paper within a hundredth of a mm", () => {
    const projected = projectRecord(frame, map().bounds, trackRecordSchema.parse(record(1)));
    const controls = projected.courses.get("1")!;
    for (const [i, c] of controls.entries()) {
      expect(c.x).toBeCloseTo(LOOP[i].x, 2);
      expect(c.y).toBeCloseTo(LOOP[i].y, 2);
    }
    expect(projected.outside).toBe(0);
    expect(projected.tracks[0].points[0].x).toBeCloseTo(LOOP[0].x, 2);
  });

  it("a course with one control is refused; a differing scale or CRS is a warning; a map without a CRS cannot place tracks", () => {
    const r = record(1);
    expect(() => trackRecordSchema.parse({ ...r, courses: [{ id: "1", controls: r.courses[0].controls.slice(0, 1) }] })).toThrow();
    const odd = projectRecord(frame, null, trackRecordSchema.parse({ ...r, projectionEpsgCode: 3007, map: { mapScale: 4000 } }));
    expect(odd.warnings.sort()).toEqual(["crs-differs", "scale-differs"]);
    const bare = { ...frame, georeferencing: { ...frame.georeferencing, crs: null } };
    expect(() => projectRecord(bare, null, trackRecordSchema.parse(r))).toThrow(TrackProjectionError);
  });
});

describe("legs (§7.9.2)", () => {
  const controls: PaperControl[] = [{ x: 5, y: 52 }, { x: 20, y: 52 }, { x: 35, y: 52 }, { x: 50, y: 52 }, { x: 65, y: 52 }].map((p, i, all) => ({ ...p, code: String(i), type: i === 0 ? "start" : i === all.length - 1 ? "finish" : "control" }));
  const made = (everyS: number, change?: (w: { t: number; p: RoutePoint }[], punches: number[]) => void, offsetS = 0): PaperTrack => {
    const { waypoints, punches } = run(controls, { pace: 0.3 }, TRUTH, seeded(1), everyS);
    change?.(waypoints, punches);
    return {
      courseId: "1", points: waypoints.map((w) => w.p), timeS: waypoints.map((w) => w.t + offsetS), startS: 0, finishS: punches[punches.length - 1],
      splits: punches.slice(1, -1).map((t, i) => ({ code: String(i + 1), atS: t })), ok: true,
    };
  };
  const opts = { groundMPerMm: 10, bounds: map().boundsMm };

  it("cuts the track at its passes of the controls, at 2, 5 and 10 s sampling", () => {
    for (const every of [2, 5, 10]) {
      const { legs, rejected } = splitTrack(controls, made(every), opts);
      expect(legs, `every ${every}`).toHaveLength(4);
      expect(rejected).toEqual({});
      // 150 m of forest at 0.3 s/m: 45 s a leg, within a sample at each end.
      for (const l of legs) expect(Math.abs(l.timeS - 45), `every ${every}`).toBeLessThanOrEqual(every);
    }
  });

  it("a watch 8 s off the punching clock is found", () => {
    const { legs } = splitTrack(controls, made(2, undefined, 8), opts);
    expect(legs).toHaveLength(4);
    for (const l of legs) expect(Math.abs(l.timeS - 45)).toBeLessThanOrEqual(2);
  });

  it("without punch times the passes are found in course order", () => {
    const t = made(2);
    const { legs } = splitTrack(controls, { ...t, splits: [], startS: null, finishS: null }, opts);
    expect(legs).toHaveLength(4);
  });

  it("a control passed twice is cut at the pass the punch time names", () => {
    const there = [{ x: 5, y: 52 }, { x: 20, y: 52 }, { x: 35, y: 52 }, { x: 20, y: 52 }, { x: 5, y: 52 }];
    const twice: PaperControl[] = there.map((p, i) => ({ ...p, code: ["S", "1", "2", "1", "F"][i], type: i === 0 ? "start" : i === 4 ? "finish" : "control" }));
    const { waypoints, punches } = run(twice, { pace: 0.3 }, TRUTH, seeded(1), 2);
    const track: PaperTrack = { courseId: "1", points: waypoints.map((w) => w.p), timeS: waypoints.map((w) => w.t), startS: 0, finishS: punches[4], splits: [1, 2, 3].map((i) => ({ code: twice[i].code, atS: punches[i] })), ok: true };
    const { legs } = splitTrack(twice, track, opts);
    expect(legs.map((l) => Math.round(l.timeS / 5) * 5)).toEqual([45, 45, 45, 45]);
  });

  it("leaves out a leg with a missed control, a gap, a stop, an off-map point or a mistake, and drops a wild fix", () => {
    // The track never comes near control 2.
    const missed = splitTrack(controls, made(2, (w) => { for (const q of w) if (Math.abs(q.p.x - 35) < 4) q.p = { x: q.p.x, y: q.p.y - 5 }; }), opts);
    expect(missed.rejected["control-missed"]).toBe(2);
    expect(missed.legs).toHaveLength(2);
    // 30 s without a fix inside leg 1.
    const gap = splitTrack(controls, made(2, (w) => { w.splice(w.findIndex((q) => q.t > 60), 15); }), opts);
    expect(gap.rejected.gap).toBe(1);
    // Off the map's edge on leg 0.
    const off = splitTrack(controls, made(2, (w) => { for (const q of w) if (q.t > 3 && q.t < 42) q.p = { x: q.p.x, y: 52 + 9 * Math.sin(((q.t - 3) / 39) * Math.PI) }; }), opts);
    expect(off.rejected["off-map"]).toBe(1);
    expect(off.legs).toHaveLength(3);
    // One fix 300 m away: dropped, the leg kept.
    const wild = splitTrack(controls, made(2, (w) => { w[8].p = { x: w[8].p.x, y: w[8].p.y - 30 }; }), opts);
    expect(wild.legs).toHaveLength(4);
    // Standing for a minute in leg 2: over a fifth of the leg.
    const stand = splitTrack(controls, made(2, (w, p) => {
      const at = w.findIndex((q) => q.t > 100);
      const still = Array.from({ length: 30 }, (_, i) => ({ t: w[at].t + 2 * (i + 1), p: w[at].p }));
      for (let i = at + 1; i < w.length; i++) w[i].t += 60;
      w.splice(at + 1, 0, ...still);
      for (let i = 3; i < p.length; i++) p[i] += 60;
    }), opts);
    expect(stand.rejected.standing).toBe(1);
    // A short stop is taken out of the leg's time and the leg kept.
    const pause = splitTrack(controls, made(2, (w, p) => {
      const at = w.findIndex((q) => q.t > 100);
      const still = Array.from({ length: 5 }, (_, i) => ({ t: w[at].t + 2 * (i + 1), p: w[at].p }));
      for (let i = at + 1; i < w.length; i++) w[i].t += 10;
      w.splice(at + 1, 0, ...still);
      for (let i = 3; i < p.length; i++) p[i] += 10;
    }), opts);
    expect(pause.legs).toHaveLength(4);
    expect(pause.legs[2].standingS).toBeGreaterThanOrEqual(10);
    expect(Math.abs(pause.legs[2].timeS - 45)).toBeLessThanOrEqual(4);
  });

  it("a leg run far slower than the runner's others is a mistake", () => {
    const rand = seeded(3);
    const long = Array.from({ length: 7 }, (_, i) => ({ x: 5 + 15 * i, y: 52 }));
    const cs: PaperControl[] = long.map((p, i) => ({ ...p, code: String(i), type: i === 0 ? "start" : i === 6 ? "finish" : "control" }));
    const { waypoints, punches } = run(cs, { pace: 0.3 }, TRUTH, rand, 2, 3);
    const track: PaperTrack = { courseId: "1", points: waypoints.map((w) => w.p), timeS: waypoints.map((w) => w.t), startS: 0, finishS: punches[6], splits: punches.slice(1, -1).map((t, i) => ({ code: String(i + 1), atS: t })), ok: true };
    const { legs, rejected } = splitTrack(cs, track, opts);
    expect(rejected.mistake).toBe(1);
    expect(legs.map((l) => l.leg)).toEqual([0, 1, 2, 4, 5]);
  });
});

describe("attribution (§7.9.3)", () => {
  const m = map((p) => p.x * 0.8);
  it("weighted by a model, the features are the polyline's cost on the finder's grid", () => {
    for (const points of [
      [{ x: 5, y: 52 }, { x: 60, y: 52 }],
      [{ x: 10, y: 5 }, { x: 30, y: 15 }, { x: 60, y: 40 }, { x: 90, y: 55 }],
      [{ x: 90, y: 37 }, { x: 10, y: 36 }],
    ] as RoutePoint[][]) {
      const req = { from: points[0], to: points[points.length - 1], groundMPerMm: 10 };
      for (const heightAt of [null, m.heightAt]) {
        const grid = legGridCovering(m.features, heightAt, req, { minX: 5, minY: 5, maxX: 90, maxY: 55 });
        const f = attributeLeg(grid, points);
        expect(featuresCost(f, DEFAULT_COST_MODEL.classFactor, DEFAULT_COST_MODEL_DATA.slope)).toBeCloseTo(routeCost(grid, DEFAULT_COST_MODEL, points), 6);
        expect(featuresCost(f, factorsOf(TRUTH), TRUTH.slope)).toBeCloseTo(routeCost(grid, costModelFromData(TRUTH), points), 6);
        expect(f.blockedM).toBe(0);
        expect(f.heightM > 0).toBe(heightAt !== null);
      }
    }
  });

  it("the grid has the leg's cell size and holds a track that leaves the leg's window", () => {
    const req = { from: { x: 40, y: 52 }, to: { x: 50, y: 52 }, groundMPerMm: 10 };
    const plain = legGridCovering(m.features, null, req);
    expect(plain.cellMm).toBe(legWindow(req).cellMm);
    const wide = legGridCovering(m.features, null, req, { minX: 40, minY: 12, maxX: 50, maxY: 52 });
    expect(wide.cellMm).toBe(plain.cellMm);
    expect(wide.y0).toBeLessThanOrEqual(10);
    const f = attributeLeg(wide, [req.from, { x: 45, y: 15 }, req.to]);
    expect(f.m[C.paved]).toBeGreaterThan(50);
    // Clamped to the leg's own window the same track would read the window's edge cells: no paved at all.
    expect(attributeLeg(plain, [req.from, { x: 45, y: 15 }, req.to]).m[C.paved]).toBe(0);
  });

  it("metres in an uncrossable cell take the nearest passable class and are counted", () => {
    const grid = buildRouteGrid({ bounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 }, cellMm: 0.5, groundMPerMm: 10, features: [{ cls: C.blocked, kind: "area", parts: [[19, 0, 21, 0, 21, 40, 19, 40]] }] });
    const f = attributeLeg(grid, [{ x: 5, y: 20 }, { x: 35, y: 20 }]);
    expect(f.totalM).toBeCloseTo(300, 6);
    expect(f.blockedM).toBeCloseTo(20, 0);
    expect(f.m[C.forest]).toBeCloseTo(300, 6);
  });
});

describe("the fit (§7.9.4)", () => {
  const observed = (runners: number, opts: Parameters<typeof record>[1] = {}) => observeRecord(map(), trackRecordSchema.parse(record(runners, opts)), 0, "a:");

  it("solves a linear system; a singular one is null", () => {
    expect(solveLinear([[2, 1], [1, 3]], [5, 10])!.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 3]);
    expect(solveLinear([[1, 2], [2, 4]], [1, 2])).toBeNull();
  });

  it("recovers the factors the runners ran by, whatever each runner's pace", () => {
    const set = observed(16);
    expect(set.tracksUsed).toBe(16);
    expect(set.medianMissM).toBeLessThan(8);
    const fit = fitCostModel(set.observations, DEFAULT_COST_MODEL_DATA, { resamples: 40 });
    expect(fit.anchor).toBe(C.forest);
    for (const c of ["paved", "open", "slow"] as const) {
      expect(fit.supported[C[c]], c).toBe(true);
      expect(Math.abs(fit.factors[C[c]] / TRUTH.classFactor[c] - 1), c).toBeLessThan(0.04);
      expect(fit.calibrated[C[c]], c).toBe(true);
      const [lo, hi] = fit.interval[C[c]]!;
      expect(lo).toBeLessThan(fit.factors[C[c]]);
      expect(hi).toBeGreaterThan(fit.factors[C[c]]);
    }
    expect(fit.calibrated[C.forest]).toBe(true);
    // A class no one ran keeps its factor and is not measured.
    expect(fit.factors[C.marsh]).toBe(DEFAULT_COST_MODEL_DATA.classFactor.marsh);
    expect(fit.calibrated[C.marsh]).toBe(false);
    // No heights: the slope stays the rule of thumb.
    expect(fit.slope).toEqual(DEFAULT_COST_MODEL_DATA.slope);
    expect(fit.slopeCalibrated).toBe(false);
  });

  it("a tenth of the runners blowing a leg moves a factor little", () => {
    const fit = fitCostModel(observeRecord(map(), trackRecordSchema.parse(record(20, { outliers: 0.3, noise: 0.03 })), 0, "a:", { mistakeFactor: 99 }).observations, DEFAULT_COST_MODEL_DATA, { resamples: 0 });
    for (const c of ["paved", "open", "slow"] as const) expect(Math.abs(fit.factors[C[c]] / TRUTH.classFactor[c] - 1), c).toBeLessThan(0.05);
  });

  it("too little track keeps the rule of thumb; without forest the class with most track is the reference", () => {
    const few = fitCostModel(observed(4).observations, DEFAULT_COST_MODEL_DATA, { resamples: 0 });
    expect(few.supported.some(Boolean)).toBe(false);
    expect(few.factors).toEqual(factorsOf(DEFAULT_COST_MODEL_DATA));
    expect(few.anchor).toBeNull();
    // Paved and open only.
    const controls = [...[5, 20, 35, 50, 65, 80, 95].map((x) => ({ x, y: 15 })), ...[50, 35, 20, 5].map((x) => ({ x, y: 37 })), ...[5, 20, 35, 50, 65, 80, 95].map((x) => ({ x, y: 15 }))];
    const set = observeRecord(map(), trackRecordSchema.parse(record(16, { controls })), 0, "a:");
    // The two crossings between the rows are forest: too little to count here.
    const fit = fitCostModel(set.observations, DEFAULT_COST_MODEL_DATA, { resamples: 20, minLegs: 40 });
    expect(fit.supported[C.forest]).toBe(false);
    expect(fit.anchor).toBe(C.paved);
    expect(fit.factors[C.paved]).toBe(DEFAULT_COST_MODEL_DATA.classFactor.paved);
    // Open relative to paved as the runners ran it.
    expect(Math.abs(fit.factors[C.open] / fit.factors[C.paved] / (TRUTH.classFactor.open / TRUTH.classFactor.paved) - 1)).toBeLessThan(0.05);
  });

  it("the slope's numbers are fitted where the tracks climb and descend", () => {
    // A ridge between x 35 and 65: up 12 % then down 12 %, flat beside it (a slope is read against flat ground).
    const heightAt = (p: RoutePoint) => 120 - Math.min(15, Math.abs(p.x - 50)) * 10 * 0.12;
    const truth = { ...TRUTH, slope: { up: 5, down: 1, kneeGrade: 0.1, steepDown: 2 } };
    const rand = seeded(5);
    // Runners simulated with the slope: time per metre × the truth's slope factor of the ridge's grade.
    const model = costModelFromData(truth);
    const set = { observations: [] as ReturnType<typeof observeRecord>["observations"] };
    const m = map(heightAt);
    for (let r = 0; r < 16; r++) {
      const pace = 0.3 * (0.8 + 0.5 * rand());
      for (let i = 1; i < LOOP.length; i++) {
        const a = LOOP[i - 1], b = LOOP[i];
        if (a.y !== b.y) continue;
        const grid = legGridCovering(m.features, heightAt, { from: a, to: b, groundMPerMm: 10 });
        const f = attributeLeg(grid, [a, b]);
        const t = pace * routeCost(grid, model, [a, b]) * (1 + 0.03 * (rand() * 2 - 1));
        set.observations.push({ runner: r, pair: `${i}`, timeS: t, f });
      }
    }
    const fit = fitCostModel(set.observations, DEFAULT_COST_MODEL_DATA, { resamples: 20 });
    expect(fit.slopeUpFitted && fit.slopeDownFitted).toBe(true);
    expect(Math.abs(fit.slope.up - 5)).toBeLessThan(0.4);
    // Down 12 %: knee at 10 %, so down and steepDown are both in play; the factor at −12 % is what the data holds.
    const at = (s: typeof fit.slope) => 1 - s.down * 0.1 + s.steepDown * 0.02;
    expect(Math.abs(at(fit.slope) - at(truth.slope))).toBeLessThan(0.03);
  });

  it("the same observations give the same fit and intervals", () => {
    const set = observed(12);
    const a = fitCostModel(set.observations, DEFAULT_COST_MODEL_DATA, { resamples: 30 });
    const b = fitCostModel(set.observations, DEFAULT_COST_MODEL_DATA, { resamples: 30 });
    expect(a).toEqual(b);
  });
});

describe("validation and the report (§7.9.5–7.9.6)", () => {
  const m = map();
  const rec = record(16);
  const set = observeRecord(m, trackRecordSchema.parse(rec), 0, "0:");
  const fit = fitCostModel(set.observations, DEFAULT_COST_MODEL_DATA, { resamples: 30 });
  const model = modelDataOf(fit, DEFAULT_COST_MODEL_DATA, "test-1", "made-up runners");

  it("no control pair is on both sides of a fold; the fitted model predicts held-out legs better than the rule of thumb", () => {
    const folds = foldsOf(set.observations);
    expect(new Set(folds.values()).size).toBe(5);
    for (const o of set.observations) expect(folds.get(o.pair)).toBeDefined();
    const cv = crossValidate(set.observations, DEFAULT_COST_MODEL_DATA);
    expect(cv.fitted.legs).toBe(cv.base.legs);
    expect(cv.fitted.legs).toBeGreaterThan(100);
    expect(cv.fitted.medianAbs).toBeLessThan(cv.base.medianAbs);
    expect(cv.fitted.medianAbs).toBeLessThan(0.06);
  });

  it("against the finder: runners on the straight, legal line take about the fastest route's time", () => {
    const ratios = finderRatios(m, set, model);
    expect(ratios.length).toBeGreaterThan(100);
    const sorted = [...ratios].sort((a, b) => a - b);
    expect(sorted[sorted.length >> 1]).toBeGreaterThan(0.93);
    expect(sorted[sorted.length >> 1]).toBeLessThan(1.1);
  });

  it("the model as data: measured classes named, rounded, usable by the finder", () => {
    expect(model.calibrated).toEqual(expect.arrayContaining(["forest", "paved", "open", "slow"]));
    expect(model.anchor).toBe("forest");
    const cm = costModelFromData(model);
    expect(cm.calibrated).toBe(true);
    expect(cm.calibratedClasses![C.paved]).toBe(true);
    expect(cm.calibratedClasses![C.marsh]).toBe(false);
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it("the report holds aggregates only: strict, and no number of it is a coordinate, a time or an id of the input", () => {
    const report = buildReport({ model, base: DEFAULT_COST_MODEL_DATA, fit, sets: [set], alongTrack: crossValidate(set.observations, DEFAULT_COST_MODEL_DATA), finder: finderRatios(m, set, model) });
    expect(calibrationReportSchema.parse(report)).toEqual(report);
    expect(report.counts).toMatchObject({ maps: 1, courses: 1, tracks: 16, tracksUsed: 16, runners: 16 });
    expect(report.classes.map((c) => c.class)).toEqual(COST_CLASSES.filter((c) => !c.startsWith("blocked")));
    expect(report.classes.find((c) => c.class === "marsh")).toMatchObject({ kept: "no-track", calibrated: false, metres: 0 });
    expect(report.classes.find((c) => c.class === "forest")).toMatchObject({ kept: "anchor", anchor: true });
    for (const extra of [{ lat: 59.3 }, { participantId: 7 }, { name: "x" }, { file: "a.ocd" }]) {
      expect(() => calibrationReportSchema.parse({ ...report, ...extra })).toThrow();
      expect(() => calibrationReportSchema.parse({ ...report, counts: { ...report.counts, ...extra } })).toThrow();
      expect(() => calibrationReportSchema.parse({ ...report, maps: [{ ...report.maps[0], ...extra }] })).toThrow();
    }
    const text = JSON.stringify(report);
    const inputs = new Set<string>();
    for (const t of rec.tracks!) {
      inputs.add(String(t.raceStartMs));
      for (const w of t.waypoints) { inputs.add(String(w.lat)); inputs.add(String(w.lng)); inputs.add(String(w.timeMs)); }
    }
    for (const c of rec.courses[0].controls) { inputs.add(String(c.lat)); inputs.add(String(c.lng)); }
    for (const v of inputs) expect(text.includes(v), v).toBe(false);
  });
});
