/**
 * What a track's leg ran over, on the finder's grid
 * (docs/course-elevation.md §7.9.3): metres per cost class, with the
 * slope's terms beside them, walked as `segmentCost` walks. Weighted by
 * a model the features are that polyline's cost.
 */

import { COST_CLASSES, DEFAULT_SLOPE, isBlockedClass, type CostModelData, type SlopeData } from "../cost-model.js";
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

export function attributeLeg(g: RouteGrid, points: readonly RoutePoint[], kneeGrade: number = DEFAULT_SLOPE.kneeGrade): LegFeatures {
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
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const lenMm = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(lenMm / (g.cellMm / 2)));
    const stepM = (lenMm / steps) * g.groundMPerMm;
    if (stepM <= 0) continue;
    let prev = classAt(cellOf(g, a), a);
    let prevZ = heightAtPoint(g, a);
    for (let s = 1; s <= steps; s++) {
      const p = { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps };
      const cur = classAt(cellOf(g, p), p);
      const z = heightAtPoint(g, p);
      const dz = z - prevZ;
      const grade = Number.isNaN(dz) ? 0 : dz / stepM;
      if (!Number.isNaN(dz)) f.heightM += stepM;
      for (const end of [prev, cur]) {
        const half = stepM / 2;
        f.m[end.cls] += half;
        if (grade >= 0) f.up[end.cls] += half * grade;
        else {
          f.down[end.cls] += half * Math.min(-grade, kneeGrade);
          f.steep[end.cls] += half * Math.max(0, -grade - kneeGrade);
        }
        if (end.blocked) f.blockedM += half;
      }
      f.gradeM[gradeBin(grade)] += stepM;
      f.totalM += stepM;
      prev = cur;
      prevZ = z;
    }
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
