/**
 * What a track's leg ran over, on the finder's grid
 * (docs/course-elevation.md §7.9.3): metres per cost class, with the
 * slope's terms beside them, walked as `segmentCost` walks. Weighted by
 * a model the features are that polyline's cost.
 */

import { CLASS_INDEX, COST_CLASSES, DEFAULT_SLOPE, isBlockedClass, type CostModelData, type SlopeData } from "../cost-model.js";
import { cellOf, heightAtPoint, nearestPassable, type RouteGrid, type RoutePoint } from "../grid.js";

export const N_CLASSES = COST_CLASSES.length;
/** Grade bin edges for the report: rise over run. */
export const GRADE_EDGES = [-0.3, -0.2, -0.1, -0.05, -0.02, 0.02, 0.05, 0.1, 0.2, 0.3] as const;
export const N_GRADE_BINS = GRADE_EDGES.length + 1;
export const gradeBin = (grade: number): number => {
  let b = 0;
  while (b < GRADE_EDGES.length && grade >= GRADE_EDGES[b]) b++;
  return b;
};

/** Per class: metres; metres × grade uphill; metres × grade downhill to the knee; metres × grade beyond the knee. */
export interface LegFeatures {
  m: Float64Array;
  up: Float64Array;
  down: Float64Array;
  steep: Float64Array;
  /** Metres per grade bin (flat where there is no height). */
  gradeM: Float64Array;
  totalM: number;
  /** Metres stepped in an uncrossable cell, read as the nearest passable cell's class. */
  blockedM: number;
  /** Metres with a known height at both ends of the step. */
  heightM: number;
}

export interface AttributeOptions {
  kneeGrade?: number;
  /**
   * A track is put on the way it follows: where it stays within this many
   * ground metres of a road or path for `snapMinRunM` or more, those
   * metres are the way's. 0 (the default) reads every step where it lies,
   * which is what a route's cost is.
   */
  snapM?: number;
  snapMinRunM?: number;
}

/** The classes a track is put on (§7.9.3): narrow ways a GPS fix seldom lies exactly on. */
const WAY_CLASSES: readonly number[] = [CLASS_INDEX.paved, CLASS_INDEX.road, CLASS_INDEX.path, CLASS_INDEX.smallPath];
export const SNAP_DEFAULTS = { snapM: 10, snapMinRunM: 40 } as const;

/** The class of the way cell nearest `p` within `rings` cells, or -1. */
function nearestWay(g: RouteGrid, p: RoutePoint, rings: number, maxMm: number): number {
  const fc = (p.x - g.x0) / g.cellMm - 0.5, fr = (p.y - g.y0) / g.cellMm - 0.5;
  const cc = Math.round(fc), rc = Math.round(fr);
  let best = -1, bestD = (maxMm / g.cellMm) ** 2;
  for (let r = Math.max(0, rc - rings); r <= Math.min(g.rows - 1, rc + rings); r++) {
    for (let c = Math.max(0, cc - rings); c <= Math.min(g.cols - 1, cc + rings); c++) {
      const cls = g.cls[r * g.cols + c];
      if (!WAY_CLASSES.includes(cls)) continue;
      const d = (r - fr) ** 2 + (c - fc) ** 2;
      if (d <= bestD) { best = cls; bestD = d; }
    }
  }
  return best;
}

export function attributeLeg(g: RouteGrid, points: readonly RoutePoint[], options: AttributeOptions | number = {}): LegFeatures {
  const o = typeof options === "number" ? { kneeGrade: options } : options;
  const kneeGrade = o.kneeGrade ?? DEFAULT_SLOPE.kneeGrade;
  const f: LegFeatures = {
    m: new Float64Array(N_CLASSES), up: new Float64Array(N_CLASSES), down: new Float64Array(N_CLASSES), steep: new Float64Array(N_CLASSES),
    gradeM: new Float64Array(N_GRADE_BINS), totalM: 0, blockedM: 0, heightM: 0,
  };
  const classAt = (cell: number, p: RoutePoint): { cls: number; blocked: boolean } => {
    const cls = g.cls[cell];
    if (!isBlockedClass(cls)) return { cls, blocked: false };
    const near = nearestPassable(g, cell, 12, p);
    return { cls: near >= 0 ? g.cls[near] : 0, blocked: true };
  };
  // The walk: sample points half a cell apart, and the steps between them.
  const at: RoutePoint[] = [];
  const steps: { from: number; to: number; m: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const lenMm = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(lenMm / (g.cellMm / 2)));
    const stepM = (lenMm / n) * g.groundMPerMm;
    if (stepM <= 0) continue;
    if (at.length === 0) at.push(a);
    for (let s = 1; s <= n; s++) {
      at.push({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
      steps.push({ from: at.length - 2, to: at.length - 1, m: stepM });
    }
  }
  const ends = at.map((p) => classAt(cellOf(g, p), p));
  const snapM = o.snapM ?? 0;
  if (snapM > 0 && at.length > 1) {
    const maxMm = snapM / g.groundMPerMm;
    const rings = Math.ceil(maxMm / g.cellMm);
    const way = at.map((p) => nearestWay(g, p, rings, maxMm));
    const minRun = o.snapMinRunM ?? SNAP_DEFAULTS.snapMinRunM;
    // A stretch beside a way: consecutive samples all near one. Crossing a path is too short to count.
    for (let i = 0; i < at.length;) {
      if (way[i] < 0) { i++; continue; }
      let j = i, run = 0;
      while (j + 1 < at.length && way[j + 1] >= 0) { run += steps[j].m; j++; }
      if (run >= minRun) for (let k = i; k <= j; k++) ends[k] = { cls: way[k], blocked: false };
      i = j + 1;
    }
  }
  for (const step of steps) {
    const z0 = heightAtPoint(g, at[step.from]), z1 = heightAtPoint(g, at[step.to]);
    const dz = z1 - z0;
    const grade = Number.isNaN(dz) ? 0 : dz / step.m;
    if (!Number.isNaN(dz)) f.heightM += step.m;
    for (const end of [ends[step.from], ends[step.to]]) {
      const half = step.m / 2;
      f.m[end.cls] += half;
      if (grade >= 0) f.up[end.cls] += half * grade;
      else {
        f.down[end.cls] += half * Math.min(-grade, kneeGrade);
        f.steep[end.cls] += half * Math.max(0, -grade - kneeGrade);
      }
      if (end.blocked) f.blockedM += half;
    }
    f.gradeM[gradeBin(grade)] += step.m;
    f.totalM += step.m;
  }
  return f;
}

/** The features' cost under a model: flat-forest metres. */
export function featuresCost(f: LegFeatures, classFactor: ArrayLike<number>, slope: SlopeData): number {
  let cost = 0;
  for (let c = 0; c < N_CLASSES; c++) {
    if (f.m[c] === 0) continue;
    cost += classFactor[c] * (f.m[c] + slope.up * f.up[c] - slope.down * f.down[c] + slope.steepDown * f.steep[c]);
  }
  return cost;
}

/** A model's factors by class index, the uncrossable classes as forest (they are never attributed). */
export const factorsOf = (data: CostModelData): number[] => COST_CLASSES.map((c) => (c === "blocked" || c === "blockedSoft" ? 1 : data.classFactor[c]));
