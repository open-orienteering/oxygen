/**
 * The cost model fitted to leg observations (docs/course-elevation.md
 * §7.9.4): leg time = the runner's pace × Σ metres × class factor ×
 * slope factor. Paces, class factors and the slope's numbers are fitted
 * in turn until they settle; a class without enough track keeps the
 * base model's factor.
 */

import { CLASS_INDEX, COST_CLASSES, isBlockedClass, type CostClass, type CostModelData, type SlopeData } from "../cost-model.js";
import { GRADE_EDGES, N_CLASSES, factorsOf, featuresCost, type LegFeatures } from "./attribute.js";

export interface FitObservation {
  /** The runner in one race: an index, never an identity. */
  runner: number;
  /** The control pair, for holding out (never reported). */
  pair: string;
  timeS: number;
  f: LegFeatures;
}

export interface FitOptions {
  /** A class is fitted from this much track… */
  minMetres?: number;
  /** …run by this many runners… */
  minRunners?: number;
  /** …on this many legs holding `legMetres` of it or more. */
  minLegs?: number;
  legMetres?: number;
  /** The slope is fitted from this many metres steeper than 5 % each way. */
  minSlopeMetres?: number;
  /** A fitted factor counts as measured when its 90 % interval is within this share of it. */
  maxIntervalShare?: number;
  resamples?: number;
  rounds?: number;
  seed?: number;
}

export const FIT_DEFAULTS = { minMetres: 2000, minRunners: 10, minLegs: 30, legMetres: 20, minSlopeMetres: 1000, maxIntervalShare: 0.15, resamples: 200, rounds: 50, seed: 1 } as const;
export const FACTOR_MIN = 0.4;
export const FACTOR_MAX = 6;

export interface ClassSupport { metres: number; seconds: number; runners: number; legs: number }

export interface FitResult {
  factors: number[];
  slope: SlopeData;
  support: ClassSupport[];
  /** Enough track to fit the class. */
  supported: boolean[];
  /** Fitted, and settled within the interval. */
  calibrated: boolean[];
  /** The 90 % interval of each fitted factor; null where it is not fitted. */
  interval: ([number, number] | null)[];
  anchor: number | null;
  slopeUpFitted: boolean;
  slopeDownFitted: boolean;
  slopeCalibrated: boolean;
  runners: number;
  observations: number;
}

export const median = (v: number[]): number => {
  if (v.length === 0) return Number.NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (v: number[], q: number): number => {
  if (v.length === 0) return Number.NaN;
  const s = [...v].sort((a, b) => a - b);
  const at = (s.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
};

/** Gaussian elimination with partial pivoting; null for a singular system. */
export function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = c + 1; r < n; r++) {
      const k = m[r][c] / m[c][c];
      for (let j = c; j <= n; j++) m[r][j] -= k * m[c][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let j = r + 1; j < n; j++) s -= m[r][j] * x[j];
    x[r] = s / m[r][r];
  }
  return x;
}

/**
 * Least squares of `rows · x = y` within `[lo, hi]` per unknown, with
 * Huber weights from the residuals of `at`. An unknown the solution puts
 * outside its bounds is held at the bound and the others solved again.
 */
function robustSolve(rows: number[][], y: number[], at: number[], lo: number[], hi: number[]): number[] | null {
  const n = at.length;
  if (n === 0) return [];
  const res = rows.map((r, i) => y[i] - r.reduce((s, v, k) => s + v * at[k], 0));
  const med = median(res);
  const scale = 1.4826 * median(res.map((r) => Math.abs(r - med))) || 1e-9;
  const w = res.map((r) => Math.min(1, (1.345 * scale) / Math.max(1e-12, Math.abs(r))));
  const held = new Map<number, number>();
  for (let pass = 0; pass <= n; pass++) {
    const free = at.map((_, j) => j).filter((j) => !held.has(j));
    if (free.length === 0) break;
    const a = free.map(() => new Array<number>(free.length).fill(0));
    const b = new Array<number>(free.length).fill(0);
    for (const [i, r] of rows.entries()) {
      let yi = y[i];
      for (const [j, v] of held) yi -= r[j] * v;
      for (const [p, j] of free.entries()) {
        b[p] += w[i] * r[j] * yi;
        for (const [q, k] of free.entries()) a[p][q] += w[i] * r[j] * r[k];
      }
    }
    // A little pull towards where it stands: two unknowns the data cannot tell apart stay put.
    for (const [p, j] of free.entries()) { const pull = 1e-6 * (a[p][p] || 1); a[p][p] += pull; b[p] += pull * at[j]; }
    const x = solveLinear(a, b);
    if (!x) return null;
    let worst = -1, by = 0;
    for (const [p, j] of free.entries()) {
      const over = Math.max(lo[j] - x[p], x[p] - hi[j]);
      if (over > by) { by = over; worst = p; }
    }
    if (worst < 0) {
      const out = at.map((_, j) => held.get(j) ?? 0);
      for (const [p, j] of free.entries()) out[j] = x[p];
      return out;
    }
    const j = free[worst];
    held.set(j, x[worst] < lo[j] ? lo[j] : hi[j]);
  }
  return at.map((_, j) => held.get(j) ?? at[j]);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function classSupport(obs: readonly FitObservation[], legMetres: number): ClassSupport[] {
  const out: ClassSupport[] = COST_CLASSES.map(() => ({ metres: 0, seconds: 0, runners: 0, legs: 0 }));
  const perRunner = COST_CLASSES.map(() => new Map<number, number>());
  for (const o of obs) {
    for (let c = 0; c < N_CLASSES; c++) {
      const m = o.f.m[c];
      if (m <= 0) continue;
      out[c].metres += m;
      out[c].seconds += o.f.totalM > 0 ? (o.timeS * m) / o.f.totalM : 0;
      if (m >= legMetres) out[c].legs++;
      perRunner[c].set(o.runner, (perRunner[c].get(o.runner) ?? 0) + m);
    }
  }
  for (let c = 0; c < N_CLASSES; c++) out[c].runners = [...perRunner[c].values()].filter((m) => m >= legMetres).length;
  return out;
}

export function runnerPaces(obs: readonly FitObservation[], factors: ArrayLike<number>, slope: SlopeData): Map<number, number> {
  const by = new Map<number, number[]>();
  for (const o of obs) {
    const cost = featuresCost(o.f, factors, slope);
    if (cost > 0) (by.get(o.runner) ?? by.set(o.runner, []).get(o.runner)!).push(o.timeS / cost);
  }
  return new Map([...by].map(([r, v]) => [r, median(v)]));
}

interface Plan { fitted: number[]; fitUp: boolean; fitDown: boolean; fitSteep: boolean }

function fitOnce(obs: readonly FitObservation[], base: CostModelData, plan: Plan, rounds: number): { factors: number[]; slope: SlopeData } {
  const factors = factorsOf(base);
  const slope = { ...base.slope };
  const slopeKeys = [...(plan.fitUp ? ["up" as const] : []), ...(plan.fitDown ? ["down" as const] : []), ...(plan.fitSteep ? ["steepDown" as const] : [])];
  if (plan.fitted.length === 0 && slopeKeys.length === 0) return { factors, slope };
  for (let round = 0; round < rounds; round++) {
    const before = [...factors, slope.up, slope.down, slope.steepDown];
    const paces = runnerPaces(obs, factors, slope);
    if (plan.fitted.length > 0) {
      const rows: number[][] = [], y: number[] = [];
      for (const o of obs) {
        const k = (paces.get(o.runner) ?? Number.NaN) / o.timeS;
        if (!Number.isFinite(k)) continue;
        const a = (c: number) => o.f.m[c] + slope.up * o.f.up[c] - slope.down * o.f.down[c] + slope.steepDown * o.f.steep[c];
        let fixed = 0;
        for (let c = 0; c < N_CLASSES; c++) if (!plan.fitted.includes(c) && o.f.m[c] > 0) fixed += factors[c] * a(c);
        rows.push(plan.fitted.map((c) => k * a(c)));
        y.push(1 - k * fixed);
      }
      const x = robustSolve(rows, y, plan.fitted.map((c) => factors[c]), plan.fitted.map(() => FACTOR_MIN), plan.fitted.map(() => FACTOR_MAX));
      if (x) for (const [i, c] of plan.fitted.entries()) factors[c] = clamp(x[i], FACTOR_MIN, FACTOR_MAX);
    }
    if (slopeKeys.length > 0) {
      const paces2 = runnerPaces(obs, factors, slope);
      const rows: number[][] = [], y: number[] = [];
      for (const o of obs) {
        const k = (paces2.get(o.runner) ?? Number.NaN) / o.timeS;
        if (!Number.isFinite(k)) continue;
        let flat = 0, up = 0, down = 0, steep = 0;
        for (let c = 0; c < N_CLASSES; c++) {
          if (o.f.m[c] === 0) continue;
          flat += factors[c] * o.f.m[c]; up += factors[c] * o.f.up[c]; down += factors[c] * o.f.down[c]; steep += factors[c] * o.f.steep[c];
        }
        const term = { up: k * up, down: -k * down, steepDown: k * steep };
        let rhs = 1 - k * flat;
        for (const key of ["up", "down", "steepDown"] as const) if (!slopeKeys.includes(key)) rhs -= term[key] * slope[key];
        rows.push(slopeKeys.map((key) => term[key]));
        y.push(rhs);
      }
      const top = (key: (typeof slopeKeys)[number]) => (key === "up" ? 25 : key === "down" ? 0.6 / slope.kneeGrade : 15);
      const x = robustSolve(rows, y, slopeKeys.map((key) => slope[key]), slopeKeys.map(() => 0), slopeKeys.map(top));
      if (x) for (const [i, key] of slopeKeys.entries()) slope[key] = clamp(x[i], 0, top(key));
    }
    const after = [...factors, slope.up, slope.down, slope.steepDown];
    if (after.every((v, i) => Math.abs(v - before[i]) < 1e-4)) break;
  }
  return { factors, slope };
}

/** A small seeded generator (mulberry32): the same input gives the same intervals. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What the observations can fit: the classes with support, the anchor among them, the slope's sides. */
export function fitPlan(obs: readonly FitObservation[], options: FitOptions = {}): { support: ClassSupport[]; supported: boolean[]; anchor: number | null; plan: Plan } {
  const o = { ...FIT_DEFAULTS, ...options };
  const support = classSupport(obs, o.legMetres);
  const supported = support.map((s, c) => !isBlockedClass(c) && s.metres >= o.minMetres && s.runners >= o.minRunners && s.legs >= o.minLegs);
  // Costs are flat-forest metres: forest is the reference where it has track; else the class with the most.
  let anchor: number | null = supported[CLASS_INDEX.forest] ? CLASS_INDEX.forest : null;
  if (anchor === null) {
    for (let c = 0; c < N_CLASSES; c++) if (supported[c] && (anchor === null || support[c].metres > support[anchor].metres)) anchor = c;
  }
  let upM = 0, downM = 0, steepM = 0;
  const upFrom = GRADE_EDGES.indexOf(0.05) + 1, downTo = GRADE_EDGES.indexOf(-0.05), steepTo = GRADE_EDGES.indexOf(-0.1);
  for (const ob of obs) {
    for (let b = 0; b < ob.f.gradeM.length; b++) {
      if (b >= upFrom) upM += ob.f.gradeM[b];
      if (b <= downTo) downM += ob.f.gradeM[b];
      if (b <= steepTo) steepM += ob.f.gradeM[b];
    }
  }
  const fitted = supported.flatMap((s, c) => (s && c !== anchor ? [c] : []));
  return { support, supported, anchor, plan: { fitted, fitUp: anchor !== null && upM >= o.minSlopeMetres, fitDown: anchor !== null && downM >= o.minSlopeMetres, fitSteep: anchor !== null && steepM >= o.minSlopeMetres / 2 } };
}

export function fitCostModel(obs: readonly FitObservation[], base: CostModelData, options: FitOptions = {}): FitResult {
  const o = { ...FIT_DEFAULTS, ...options };
  const { support, supported, anchor, plan } = fitPlan(obs, o);
  const { factors, slope } = fitOnce(obs, base, plan, o.rounds);
  const runners = [...new Set(obs.map((x) => x.runner))];
  const byRunner = new Map<number, FitObservation[]>();
  for (const x of obs) (byRunner.get(x.runner) ?? byRunner.set(x.runner, []).get(x.runner)!).push(x);
  const samples: number[][] = plan.fitted.map(() => []);
  const slopeSamples: { up: number[]; down: number[] } = { up: [], down: [] };
  const rand = seeded(o.seed);
  if (plan.fitted.length > 0 || plan.fitUp || plan.fitDown) {
    for (let k = 0; k < o.resamples; k++) {
      const drawn: FitObservation[] = [];
      for (let i = 0; i < runners.length; i++) {
        const r = runners[Math.floor(rand() * runners.length)];
        for (const x of byRunner.get(r)!) drawn.push({ ...x, runner: i });
      }
      const fit = fitOnce(drawn, base, plan, Math.min(o.rounds, 12));
      for (const [i, c] of plan.fitted.entries()) samples[i].push(fit.factors[c]);
      slopeSamples.up.push(fit.slope.up);
      slopeSamples.down.push(fit.slope.down);
    }
  }
  const interval: ([number, number] | null)[] = COST_CLASSES.map(() => null);
  const calibrated = COST_CLASSES.map(() => false);
  for (const [i, c] of plan.fitted.entries()) {
    const lo = quantile(samples[i], 0.05), hi = quantile(samples[i], 0.95);
    interval[c] = [lo, hi];
    calibrated[c] = (hi - lo) / 2 <= o.maxIntervalShare * factors[c] && factors[c] > FACTOR_MIN + 1e-9 && factors[c] < FACTOR_MAX - 1e-9;
  }
  // The anchor is measured as the others' reference, when anything was fitted against it.
  if (anchor !== null && plan.fitted.some((c) => calibrated[c])) calibrated[anchor] = true;
  const settled = (v: number[], at: number) => v.length > 0 && (quantile(v, 0.95) - quantile(v, 0.05)) / 2 <= 2 * o.maxIntervalShare * Math.max(at, 1e-6);
  const slopeCalibrated = plan.fitUp && plan.fitDown && settled(slopeSamples.up, slope.up) && settled(slopeSamples.down, slope.down);
  return {
    factors, slope, support, supported, calibrated, interval, anchor,
    slopeUpFitted: plan.fitUp, slopeDownFitted: plan.fitDown, slopeCalibrated, runners: runners.length, observations: obs.length,
  };
}

/** The fit as model data under `id`. */
export function modelDataOf(fit: FitResult, base: CostModelData, id: string, basedOn: string): CostModelData {
  const classFactor = { ...base.classFactor };
  for (const c of COST_CLASSES) {
    if (c === "blocked" || c === "blockedSoft") continue;
    classFactor[c] = Math.round(fit.factors[CLASS_INDEX[c]] * 1000) / 1000;
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    id, basedOn, classFactor,
    slope: { up: r3(fit.slope.up), down: r3(fit.slope.down), kneeGrade: fit.slope.kneeGrade, steepDown: r3(fit.slope.steepDown) },
    calibrated: COST_CLASSES.filter((_, i) => fit.calibrated[i]) as CostClass[],
    ...(fit.anchor !== null && fit.calibrated[fit.anchor] ? { anchor: COST_CLASSES[fit.anchor] } : {}),
    slopeCalibrated: fit.slopeCalibrated,
  };
}

export { fitOnce as _fitOnce };
