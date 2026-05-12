import { useMemo } from "react";
import { trpc } from "../lib/trpc";

/**
 * Resolve a structured-search class anchor value to the list of course
 * names assigned to that class. Used by `RunnerMapPreview` /
 * `CardMapPreview` to highlight the matching course on the map when the
 * user has set a class filter but no individual row is expanded.
 *
 * - Returns `undefined` when there's no class filter, when the class
 *   isn't found, or when the class has no courses assigned.
 * - Uses the already-cached `trpc.class.list` query (long stale time) so
 *   that switching between pages doesn't trigger extra round-trips.
 * - Multi-class OR groups (e.g. `class:D21|class:H21`) aren't this hook's
 *   job — callers pass a single value; OR groups fall through to plain
 *   overview.
 */
export function useDefaultMapCourseNames(
  classAnchorValue: string | undefined,
): string[] | undefined {
  const classes = trpc.class.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  return useMemo(() => {
    if (!classAnchorValue || !classes.data) return undefined;
    const cls = classes.data.find((c) => c.name === classAnchorValue);
    return cls?.courseNames?.length ? cls.courseNames : undefined;
  }, [classAnchorValue, classes.data]);
}
