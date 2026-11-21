/**
 * The height profile of a polyline and of a course (docs/course-elevation.md §1–2).
 */

import { CLIMB_THRESHOLD_M, climbShares, hysteresisClimb, hysteresisDescent } from "./climb.js";
import type { CourseLegProfile, CourseProfile, PaperPoint, PolylineProfile, ProfileOptions, ProfileSample, TerrainSampler } from "./types.js";

/** The default sampling step for a sampler, ground metres (§1 "Sampling"). */
export const profileStepM = (sampler: Pick<TerrainSampler, "cellM">): number => Math.max(1, sampler.cellM / 2);

export function profileAlong(points: readonly PaperPoint[], sampler: TerrainSampler, opts: ProfileOptions = {}): PolylineProfile {
  const stepM = opts.stepM && opts.stepM > 0 ? opts.stepM : profileStepM(sampler);
  const thresholdM = opts.thresholdM ?? CLIMB_THRESHOLD_M;
  const samples: ProfileSample[] = [];
  const at = (p: PaperPoint, dM: number) => {
    const zM = sampler.heightAt(p);
    samples.push({ dM, zM, confident: zM !== null && sampler.confidentAt(p) });
  };
  let lengthM = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const segM = Math.hypot(b.x - a.x, b.y - a.y) * sampler.groundMPerMm;
    if (!(segM > 0)) continue;
    if (samples.length === 0) at(a, 0);
    const n = Math.max(1, Math.ceil(segM / stepM - 1e-9));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      at(k === n ? b : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, lengthM + segM * t);
    }
    lengthM += segM;
  }
  if (samples.length === 0) return { lengthM: 0, samples, climbM: 0, descentM: 0, netM: null, coverage: 0, confidence: 0 };

  // Shares of length: each sample stands for the half-steps beside it.
  let withData = 0, confident = 0;
  for (let i = 0; i < samples.length; i++) {
    const before = i > 0 ? (samples[i].dM - samples[i - 1].dM) / 2 : 0;
    const after = i + 1 < samples.length ? (samples[i + 1].dM - samples[i].dM) / 2 : 0;
    if (samples[i].zM !== null) withData += before + after;
    if (samples[i].confident) confident += before + after;
  }
  const heights: number[] = [];
  for (const s of samples) if (s.zM !== null) heights.push(s.zM);
  const first = samples[0].zM, last = samples[samples.length - 1].zM;
  return {
    lengthM,
    samples,
    climbM: hysteresisClimb(heights, thresholdM),
    descentM: hysteresisDescent(heights, thresholdM),
    netM: first !== null && last !== null ? last - first : null,
    coverage: Math.min(1, withData / lengthM),
    confidence: Math.min(1, confident / lengthM),
  };
}

/** Below this share of length with data a course's totals are flagged partial (§2 "A course"). */
export const PARTIAL_COVERAGE = 0.995;

/**
 * The profile of a course from its legs' polylines, in order (§2 "A
 * course"): the rule runs once over the whole course, so a rise that
 * spans a control counts, and each leg gets its share of every rise.
 */
export function courseProfile(legs: readonly { points: readonly PaperPoint[] }[], sampler: TerrainSampler, opts: ProfileOptions = {}): CourseProfile {
  const thresholdM = opts.thresholdM ?? CLIMB_THRESHOLD_M;
  const profiles = legs.map((leg) => profileAlong(leg.points, sampler, opts));
  // The course's heights in order, and each leg's range in them; a leg's first height repeats the last of the leg before.
  const heights: number[] = [];
  const bounds: number[] = [0];
  for (const p of profiles) {
    for (const s of p.samples) if (s.zM !== null) heights.push(s.zM);
    bounds.push(Math.max(0, heights.length - 1));
  }
  const up = climbShares(heights, bounds, thresholdM);
  const down = climbShares(heights.map((z) => -z), bounds, thresholdM);
  const out: CourseLegProfile[] = [];
  let lengthM = 0, climbM = 0, descentM = 0, withData = 0, confident = 0;
  profiles.forEach((profile, k) => {
    const has = profile.coverage > 0;
    out.push({ offsetM: lengthM, profile, climbM: has ? up[k] : null, descentM: has ? down[k] : null });
    lengthM += profile.lengthM;
    climbM += up[k];
    descentM += down[k];
    withData += profile.coverage * profile.lengthM;
    confident += profile.confidence * profile.lengthM;
  });
  const coverage = lengthM > 0 ? Math.min(1, withData / lengthM) : 0;
  return { legs: out, lengthM, climbM, descentM, coverage, confidence: lengthM > 0 ? Math.min(1, confident / lengthM) : 0, partial: lengthM > 0 && coverage < PARTIAL_COVERAGE };
}

/** The paper point `dM` ground metres along a polyline (clamped to its ends); null for fewer than two points. */
export function pointAtDistance(points: readonly PaperPoint[], groundMPerMm: number, dM: number): PaperPoint | null {
  if (points.length < 2) return null;
  let left = Math.max(0, dM) / groundMPerMm;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg > 0 && left <= seg) return { x: a.x + ((b.x - a.x) * left) / seg, y: a.y + ((b.y - a.y) * left) / seg };
    left -= seg;
  }
  const end = points[points.length - 1];
  return { x: end.x, y: end.y };
}

/** The place on a polyline nearest to p: its distance along, ground metres, and how far off p is, paper mm; null for fewer than two points. */
export function distanceAtPoint(points: readonly PaperPoint[], groundMPerMm: number, p: PaperPoint): { dM: number; offMm: number } | null {
  if (points.length < 2) return null;
  let best: { dM: number; offMm: number } | null = null;
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const off = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    const seg = Math.sqrt(len2);
    if (!best || off < best.offMm) best = { dM: (along + seg * t) * groundMPerMm, offMm: off };
    along += seg;
  }
  return best;
}
