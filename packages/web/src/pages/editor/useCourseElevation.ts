/**
 * The selected course's heights for the editor (docs/course-elevation.md
 * §4): the event's climb field (`pickClimbField` over
 * `course.mapMetadata.terrain`), fetched once and kept by `useHeightField`,
 * and the shared course profile over the legs the viewer draws. The field
 * is asked for only while there are legs to read it along.
 */

import { useMemo } from "react";
import { courseProfile, fieldSampler, pickClimbField, type ClimbTerrainLike, type PaperPoint } from "@oxygen/shared/src/terrain/profile/index.js";
import { useHeightField } from "../../hooks/useHeightField";
import type { CourseElevation } from "../../lib/editor/elevation";

export interface CourseElevationInput {
  /** `course.mapMetadata.terrain`. */
  terrain: ClimbTerrainLike | null | undefined;
  /** The course's legs as drawn; null when there is no ordered course drawn alone. */
  legs: readonly { points: readonly PaperPoint[] }[] | null;
  nameId: string | null;
}

export function useCourseElevation({ terrain, legs, nameId }: CourseElevationInput): { elevation: CourseElevation; retry: () => void } {
  const pick = useMemo(() => pickClimbField(terrain), [terrain]);
  const wanted = !!pick && !!legs && legs.length > 0;
  const { state, retry } = useHeightField(wanted ? pick.url : null, nameId);
  const field = state.status === "ready" ? state.field : null;
  const sampler = useMemo(() => (field ? fieldSampler(field) : null), [field]);
  const profile = useMemo(() => (sampler && legs && legs.length > 0 ? courseProfile(legs, sampler) : null), [sampler, legs]);
  const elevation = useMemo<CourseElevation>(() => {
    if (!wanted || !pick) return { state: "none" };
    if (state.status === "error") return { state: "unavailable", kind: state.kind };
    if (!sampler || !profile) return { state: "loading" };
    return {
      state: "ready", profile, basis: pick.basis,
      attribution: (sampler.provider ?? pick.provider)?.attribution ?? null,
      datum: sampler.datum, groundMPerMm: sampler.groundMPerMm,
    };
  }, [wanted, pick, state, sampler, profile]);
  return { elevation, retry };
}
