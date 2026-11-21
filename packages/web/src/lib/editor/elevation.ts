/**
 * What the editor says about heights along the selected course
 * (docs/course-elevation.md §4): the line climb's values for the course-info
 * rows and the selected leg's numbers, from the shared course profile.
 */

import type { ClimbBasis, CourseProfile } from "@oxygen/shared/src/terrain/profile/index.js";

/** Below this share of confident length a number is shown as approximate (the 3D gate's share, docs/map-terrain.md §5.5). */
export const ELEVATION_CONFIDENT_MIN = 0.8;

export type ElevationUnavailable = "offline" | "pending" | "failed" | "missing" | "unauthorised";

/** The course's heights as the editor holds them (§4.3). */
export type CourseElevation =
  /** No field to read, or no course drawn alone: nothing is shown. */
  | { state: "none" }
  | { state: "loading" }
  | { state: "unavailable"; kind: ElevationUnavailable }
  | { state: "ready"; profile: CourseProfile; basis: ClimbBasis; attribution: string | null; datum: "relative" | "absolute"; groundMPerMm: number };

/** The line climb of the course-info rows (`lib/editor/status.ts`). */
export type LineClimbStatus =
  | { state: "loading" }
  | { state: "unavailable"; kind: ElevationUnavailable }
  | {
      state: "ready";
      climbM: number;
      descentM: number;
      /** Climb as a share of the profile's length, percent to one decimal; null for a zero length. */
      sharePct: number | null;
      basis: ClimbBasis;
      /** Less than the whole length has data: a lower bound. */
      partial: boolean;
      /** Shown with "≈": partial, or too little of the length is confident. */
      approx: boolean;
      attribution: string | null;
    };

/** A metre value as shown: rounded once, never `-0`. */
export const shownM = (m: number): number => Math.round(m) + 0;

export function lineClimbStatus(e: CourseElevation): LineClimbStatus | null {
  if (e.state === "none") return null;
  if (e.state !== "ready") return e;
  const p = e.profile;
  if (p.lengthM <= 0 || p.coverage <= 0) return null;
  return {
    state: "ready",
    climbM: shownM(p.climbM),
    descentM: shownM(p.descentM),
    sharePct: Math.round((p.climbM / p.lengthM) * 1000) / 10,
    basis: e.basis,
    partial: p.partial,
    approx: p.partial || p.confidence < ELEVATION_CONFIDENT_MIN,
    attribution: e.attribution,
  };
}

/** The selected leg's numbers (§4.5); a value is null where the leg has no data. */
export interface LegElevation {
  lengthM: number;
  climbM: number | null;
  descentM: number | null;
  netM: number | null;
  basis: ClimbBasis;
  approx: boolean;
  /** The numbers are read along the leg's chosen route (§7.3), not its drawn line. */
  routed: boolean;
}

export function legElevation(e: CourseElevation, legIndex: number | null, routed = false): LegElevation | null {
  if (e.state !== "ready" || legIndex === null) return null;
  const leg = e.profile.legs[legIndex];
  if (!leg) return null;
  const p = leg.profile;
  return {
    lengthM: shownM(p.lengthM),
    climbM: leg.climbM === null ? null : shownM(leg.climbM),
    descentM: leg.descentM === null ? null : shownM(leg.descentM),
    netM: p.netM === null ? null : shownM(p.netM),
    basis: e.basis,
    approx: p.coverage < 0.995 || p.confidence < ELEVATION_CONFIDENT_MIN,
    routed,
  };
}
