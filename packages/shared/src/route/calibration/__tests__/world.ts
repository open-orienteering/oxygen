/**
 * A made-up terrain and made-up runners for the calibration tests
 * (docs/course-elevation.md §7.9): 100 × 60 mm at 1:10 000 on a
 * SWEREF 99 TM frame, a paved band, an open and a slow block in forest.
 * No real track is in any fixture.
 */

import { paperToWgs84, type PaperFrame } from "../../../geo/projection.js";
import { CLASS_INDEX, DEFAULT_COST_MODEL_DATA, type CostModelData } from "../../cost-model.js";
import type { RoutePoint } from "../../grid.js";
import { boxedFeature } from "../../leg.js";
import type { CalibrationMap } from "../dataset.js";
import { seeded } from "../fit.js";
import type { TrackRecord } from "../record.js";

export const frame: PaperFrame = {
  unitsPerMm: 100, mapScale: 10000,
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 674000, y: 6580000 }, gridRotationDeg: 0, gridScaleFactor: 1 },
};
const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];
const BLOCKS = [
  { cls: "paved", box: [0, 10, 100, 20] },
  { cls: "open", box: [0, 30, 50, 45] },
  { cls: "slow", box: [50, 30, 100, 45] },
] as const;

export const map = (heightAt: CalibrationMap["heightAt"] = null): CalibrationMap => ({
  features: BLOCKS.map((b) => boxedFeature(CLASS_INDEX[b.cls], "area", [rect(b.box[0], b.box[1], b.box[2], b.box[3])])),
  heightAt, frame,
  bounds: { minX: 0, minY: 0, maxX: 10000, maxY: 6000 },
  boundsMm: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  groundMPerMm: 10,
});

export const classAt = (p: RoutePoint): keyof CostModelData["classFactor"] => BLOCKS.find((b) => p.x >= b.box[0] && p.x < b.box[2] && p.y >= b.box[1] && p.y < b.box[3])?.cls ?? "forest";

/** The truth the made-up runners run by. */
export const TRUTH: CostModelData = { ...DEFAULT_COST_MODEL_DATA, id: "truth", classFactor: { ...DEFAULT_COST_MODEL_DATA.classFactor, paved: 0.5, open: 0.9, slow: 1.6 } };

const row = (y: number, xs: number[]) => xs.map((x) => ({ x, y }));
/** Every 50 m: nine control pairs in each block, so a class rests on more than a few legs. */
export const XS = Array.from({ length: 19 }, (_, i) => 5 + 5 * i);
/** Paved row east, slow and open row west, forest row east. */
export const LOOP: RoutePoint[] = [...row(15, XS), ...row(37, [...XS].reverse()), ...row(52, XS)];

export interface Runner { pace: number; noise?: number }

/** A runner along `controls` under `truth`: waypoints every `everyS` and the punch times. */
export function run(controls: readonly RoutePoint[], runner: Runner, truth: CostModelData, rand: () => number, everyS = 2, slowLeg: number | null = null) {
  const g = 10;
  const waypoints: { t: number; p: RoutePoint }[] = [{ t: 0, p: controls[0] }];
  const punches: number[] = [0];
  let t = 0, nextSample = everyS;
  for (let i = 1; i < controls.length; i++) {
    const a = controls[i - 1], b = controls[i];
    const lenM = Math.hypot(b.x - a.x, b.y - a.y) * g;
    const legFactor = (1 + (runner.noise ?? 0) * (rand() * 2 - 1)) * (slowLeg === i - 1 ? 4 : 1);
    const steps = Math.max(1, Math.ceil(lenM));
    for (let s = 1; s <= steps; s++) {
      const mid = { x: a.x + ((b.x - a.x) * (s - 0.5)) / steps, y: a.y + ((b.y - a.y) * (s - 0.5)) / steps };
      const dt = (lenM / steps) * runner.pace * truth.classFactor[classAt(mid)] * legFactor;
      const end = { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps };
      while (nextSample <= t + dt) {
        const k = (nextSample - t) / dt;
        const from = { x: a.x + ((b.x - a.x) * (s - 1)) / steps, y: a.y + ((b.y - a.y) * (s - 1)) / steps };
        waypoints.push({ t: nextSample, p: { x: from.x + (end.x - from.x) * k, y: from.y + (end.y - from.y) * k } });
        nextSample += everyS;
      }
      t += dt;
    }
    punches.push(t);
  }
  waypoints.push({ t, p: controls[controls.length - 1] });
  return { waypoints, punches };
}

export const latLng = (p: RoutePoint) => {
  const q = paperToWgs84(frame, p.x * frame.unitsPerMm, p.y * frame.unitsPerMm)!;
  return { lat: q.lat, lng: q.lng };
};

/** A record of `runners` made-up runners over the loop, as the tool reads it. */
export function record(runners: number, opts: { truth?: CostModelData; seed?: number; noise?: number; everyS?: number; outliers?: number; controls?: RoutePoint[]; key?: "tracks" | "kept" } = {}): TrackRecord {
  const rand = seeded(opts.seed ?? 7);
  const controls = opts.controls ?? LOOP;
  const startMs = 1_700_000_000_000;
  const tracks = Array.from({ length: runners }, (_, r) => {
    const pace = 0.3 * (0.8 + 0.5 * rand());
    const slowLeg = rand() < (opts.outliers ?? 0) ? Math.floor(rand() * (controls.length - 1)) : null;
    const { waypoints, punches } = run(controls, { pace, noise: opts.noise ?? 0.03 }, opts.truth ?? TRUTH, rand, opts.everyS ?? 2, slowLeg);
    return {
      courseId: "1",
      raceStartMs: startMs + r * 60_000,
      waypoints: waypoints.map((w) => ({ timeMs: startMs + r * 60_000 + w.t * 1000, ...latLng(w.p) })),
      result: {
        status: "ok", timeMs: punches[punches.length - 1] * 1000,
        splitTimes: punches.slice(1, -1).map((t, i) => ({ controlCode: String(31 + i), timeMs: t * 1000 })),
      },
    };
  });
  return {
    projectionEpsgCode: 3006, map: { mapScale: 10000 },
    courses: [{ id: "1", controls: controls.map((p, i) => ({ code: i === 0 ? "S" : i === controls.length - 1 ? "F" : String(30 + i), type: i === 0 ? "start" as const : i === controls.length - 1 ? "finish" as const : "control" as const, ...latLng(p) })) }],
    [opts.key ?? "tracks"]: tracks,
  } as TrackRecord;
}
