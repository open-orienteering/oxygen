import { useMemo } from "react";
import { trpc } from "../lib/trpc";

/**
 * Resolve a structured-search class anchor value to the list of course
 * names assigned to that class. Used by `RunnerMapPreview` /
 * `CardMapPreview` to highlight the matching course on the map when the
 * user has set a class filter but no individual row is expanded.
 *
 * - Returns `undefined` when there's no class filter, the class isn't
 *   found, or the class has no assigned course.
 * - Derives the answer from `competition.dashboard` (already cached at
 *   the shell level) instead of firing a separate `class.list` query —
 *   that saves one tRPC roundtrip per Runners/StartList/Results/Cards
 *   page mount.
 * - Multi-class OR-groups in the search bar aren't this hook's job —
 *   callers pass a single value; OR groups fall through to plain
 *   overview.
 *
 * Forked classes (multiple courses per class) are not supported by the
 * dashboard payload — those fall through to overview here. If a future
 * requirement needs them, switch this back to `trpc.class.list` (which
 * exposes the array shape) at the cost of an extra query.
 */
export function useDefaultMapCourseNames(
  classAnchorValue: string | undefined,
): string[] | undefined {
  const dashboard = trpc.competition.dashboard.useQuery(undefined, {
    staleTime: 30_000,
  });
  return useMemo(() => {
    if (!classAnchorValue || !dashboard.data) return undefined;
    const cls = dashboard.data.classes.find(
      (c) => c.name === classAnchorValue,
    );
    if (!cls?.courseId) return undefined;
    const course = dashboard.data.courses.find((c) => c.id === cls.courseId);
    return course ? [course.name] : undefined;
  }, [classAnchorValue, dashboard.data]);
}
