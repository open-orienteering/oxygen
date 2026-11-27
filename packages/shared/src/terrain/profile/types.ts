/**
 * Heights along a polyline over a height field (docs/course-elevation.md §1–3).
 */

import type { HeightFieldProvider } from "../field/types.js";
import type { PaperPoint } from "../field/sample.js";

export type { PaperPoint };

/** One reader of terrain at a paper point (§1): every profile reads through it, never a field directly. */
export interface TerrainSampler {
  /** Height in metres at p; null outside the field or in a no-data cell. */
  heightAt(p: PaperPoint): number | null;
  /** The field's confidence bit at p (false outside). */
  confidentAt(p: PaperPoint): boolean;
  /** Ground metres per paper mm. */
  groundMPerMm: number;
  /** The field cell on the ground, metres. */
  cellM: number;
  datum: "relative" | "absolute";
  /** The field's `source` (`contours`, `contours.<id>`, `ground.<id>`). */
  source: string;
  provider?: HeightFieldProvider;
}

export interface ProfileSample {
  /** Along the polyline on the ground from its first point, metres. */
  dM: number;
  /** Height in metres; null without data. */
  zM: number | null;
  confident: boolean;
}

export interface ProfileOptions {
  /** Sampling step on the ground, metres; default `max(1, sampler.cellM / 2)`. */
  stepM?: number;
  /** The hysteresis threshold (§2), metres; default `CLIMB_THRESHOLD_M`. */
  thresholdM?: number;
}

export interface PolylineProfile {
  /** Along the polyline on the ground, metres (unrounded). */
  lengthM: number;
  samples: ProfileSample[];
  /** §2, unrounded metres. */
  climbM: number;
  descentM: number;
  /** Height at the last sample minus the first; null unless both have data. */
  netM: number | null;
  /** Share of `lengthM` with data, 0..1. */
  coverage: number;
  /** Share of `lengthM` whose samples have data and are confident, 0..1. */
  confidence: number;
}

/** One leg of a course profile (§2 "A course"). */
export interface CourseLegProfile {
  /** Where the leg starts along the course, metres. */
  offsetM: number;
  profile: PolylineProfile;
  /** The leg's share of the course's climb (§2 "A course"), unrounded; null when the leg has no data at all. */
  climbM: number | null;
  descentM: number | null;
}

export interface CourseProfile {
  legs: CourseLegProfile[];
  lengthM: number;
  /** The course's climb in one pass over its legs; the legs' shares sum to it. */
  climbM: number;
  descentM: number;
  coverage: number;
  confidence: number;
  /** Less than `PARTIAL_COVERAGE` of the length has data: the totals are a lower bound. */
  partial: boolean;
}
