/**
 * The selected course's heights for the editor (docs/course-elevation.md
 * §4): the event's climb field (`pickClimbField` over
 * `course.mapMetadata.terrain`), fetched once and kept by `useHeightField`,
 * and the shared course profile over the legs the viewer draws. The field
 * is asked for while a course it can be read along is selected (§4.1).
 */

import { useDeferredValue, useMemo } from "react";
import { courseProfile, fieldSampler, pickClimbField, type ClimbTerrainLike, type PaperPoint, type TerrainSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import { useHeightField } from "../../hooks/useHeightField";
import type { CourseElevation } from "../../lib/editor/elevation";

export interface CourseElevationInput {
  /** `course.mapMetadata.terrain`. */
  terrain: ClimbTerrainLike | null | undefined;
  /** §4.1 holds: an ordered course is selected in Course mode's Course view. The field is asked for while it does. */
  active: boolean;
  /** The course's legs as they are read — each along its chosen route when it has one (§7.3), else as drawn; null until the viewer has derived them (or while it draws something else). */
  legs: readonly { points: readonly PaperPoint[] }[] | null;
  nameId: string | null;
}

export function useCourseElevation({ terrain, active, legs: liveLegs, nameId }: CourseElevationInput): { elevation: CourseElevation; sampler: TerrainSampler | null; retry: () => void } {
  // The profile follows a drag one render behind: the drag's own frames come first.
  const legs = useDeferredValue(liveLegs);
  const pick = useMemo(() => pickClimbField(terrain), [terrain]);
  const wanted = !!pick && active;
  const { state, retry } = useHeightField(wanted ? pick.url : null, nameId);
  const field = state.status === "ready" ? state.field : null;
  const sampler = useMemo(() => (field ? fieldSampler(field) : null), [field]);
  const profile = useMemo(() => (sampler && legs && legs.length > 0 ? courseProfile(legs, sampler) : null), [sampler, legs]);
  const elevation = useMemo<CourseElevation>(() => {
    if (!wanted || !pick || !legs || legs.length === 0) return { state: "none" };
    if (state.status === "error") return { state: "unavailable", kind: state.kind };
    if (!sampler || !profile) return { state: "loading" };
    // No length or no data at all: nothing to state (§4.3).
    if (profile.lengthM <= 0 || profile.coverage <= 0) return { state: "none" };
    return {
      state: "ready", profile, basis: pick.basis,
      attribution: (sampler.provider ?? pick.provider)?.attribution ?? null,
      datum: sampler.datum, groundMPerMm: sampler.groundMPerMm,
    };
  }, [wanted, pick, legs, state, sampler, profile]);
  return { elevation, sampler, retry };
}
