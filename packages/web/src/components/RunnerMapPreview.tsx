import { useMemo } from "react";
import { trpc } from "../lib/trpc";
import { MapSlot } from "./MapSlot";

interface Props {
  /**
   * Runner whose course / punches / GPS track to highlight on the map.
   * When `null`/`undefined`, the map falls back to the page's class
   * filter (`defaultCourseNames`) or, failing that, a plain overview.
   */
  runnerId?: number | null;
  /**
   * Course names to highlight when no runner is selected. Driven from the
   * page's structured-search class anchor via `useDefaultMapCourseNames`.
   * Single-class is the common case; forked classes may yield several.
   */
  defaultCourseNames?: string[];
}

/**
 * Shared map preview used by the Runners, StartList, and Results pages.
 *
 * Driven by the expanded `runnerId` of the parent table:
 * - **No runner expanded** → highlight `defaultCourseNames` (or plain
 *   overview when no class filter is set).
 * - **Unfinished runner** → assigned course outline only.
 * - **Finished OK runner** → course outline + all controls coloured "ok"
 *   green + GPS overlay when a synced Livelox route exists.
 * - **Mispunched runner** → course outline + mixed status colours
 *   (missing red, extra amber, ok green) + GPS overlay if available.
 */
export function RunnerMapPreview({ runnerId, defaultCourseNames }: Props) {
  const readout = trpc.cardReadout.readoutByRunner.useQuery(
    { runnerId: runnerId ?? 0 },
    { enabled: !!runnerId, staleTime: 5_000 },
  );
  const route = trpc.livelox.routeByRunner.useQuery(
    { runnerId: runnerId ?? 0 },
    { enabled: !!runnerId, staleTime: 60_000 },
  );

  const readoutCourseName = readout.data?.course?.name ?? undefined;

  // Build the per-control status map from the readout. Empty when there's
  // no readout (unfinished runner / no row expanded) — MapPanel just
  // skips colouring controls in that case.
  const punchStatusByCode = useMemo(() => {
    const d = readout.data;
    if (!d) return undefined;
    const m: Record<string, "ok" | "missing" | "extra"> = {};
    for (const c of d.controls) {
      m[String(c.controlCode)] = c.status;
    }
    for (const e of d.extraPunches) {
      m[String(e.controlCode)] = "extra";
    }
    return Object.keys(m).length ? m : undefined;
  }, [readout.data]);

  // Pull out the waypoints early as `unknown` to dodge the deep
  // JsonValue type explosion that comes from Prisma's JSONB column.
  const routeWaypoints = route.data
    ? ((route.data as { waypoints?: unknown }).waypoints as
        | Array<{ lat: number; lng: number }>
        | null
        | undefined)
    : null;

  const gpsRoutes = useMemo(() => {
    if (!routeWaypoints) return undefined;
    return [
      {
        color: "#e6194b",
        points: routeWaypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
      },
    ];
  }, [routeWaypoints]);

  // Course precedence: readout course (specific runner) wins over the
  // page-level class filter. Both fall through to plain overview when
  // neither produces a course name.
  // Wrap in useMemo so the resulting array has a stable identity across
  // renders that don't change the underlying course list, letting
  // React.memo on the shell-owned MapPanel short-circuit re-renders.
  const highlightCourseNames = useMemo(
    () =>
      readoutCourseName ? [readoutCourseName] : defaultCourseNames,
    [readoutCourseName, defaultCourseNames],
  );

  const hasCourse = !!highlightCourseNames?.length;

  return (
    <MapSlot
      fitToControls
      filterMode={hasCourse ? "course" : "all"}
      highlightCourseNames={highlightCourseNames}
      punchStatusByCode={punchStatusByCode}
      gpsRoutes={gpsRoutes}
    />
  );
}
