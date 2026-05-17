import { useMemo } from "react";
import { trpc } from "../lib/trpc";
import { MapSlot } from "./MapSlot";

interface Props {
  /**
   * SI card number to drive the map preview. When `null`/`undefined` (no
   * card row expanded), the map falls back to the page's class filter or
   * a plain overview.
   */
  cardNo?: number | null;
  /**
   * Course names to highlight when no card is selected (or when the
   * selected card has no linked runner). Driven from the page's
   * structured-search class anchor via `useDefaultMapCourseNames`.
   */
  defaultCourseNames?: string[];
}

/**
 * Map preview for the Cards page. Reuses the same readout/track pipeline
 * as `RunnerMapPreview`, but keyed by `cardNo`:
 *
 * 1. `cardReadout.readout({ cardNo })` returns the linked runner +
 *    matched course + per-control status. Cards without a linked runner
 *    yield `{ found: false }`, in which case we fall back to
 *    `defaultCourseNames` (page-level class filter) or plain overview.
 * 2. When a runner is linked, chain into `livelox.routeByRunner` to
 *    overlay a synced GPS track if one exists.
 */
export function CardMapPreview({ cardNo, defaultCourseNames }: Props) {
  const readout = trpc.cardReadout.readout.useQuery(
    { cardNo: cardNo ?? 0 },
    { enabled: !!cardNo, staleTime: 5_000 },
  );

  // Pull the runner ID out of the readout (if a runner is linked) so we
  // can chain into the per-runner GPS route lookup. The intermediate
  // query is cheap when disabled; it auto-runs when readout resolves.
  const linkedRunnerId =
    readout.data?.found && readout.data.runner?.id
      ? readout.data.runner.id
      : undefined;

  const route = trpc.livelox.routeByRunner.useQuery(
    { runnerId: linkedRunnerId ?? 0 },
    { enabled: !!linkedRunnerId, staleTime: 60_000 },
  );

  const readoutCourseName =
    readout.data?.found && readout.data.course
      ? readout.data.course.name
      : undefined;

  const punchStatusByCode = useMemo(() => {
    const d = readout.data;
    if (!d?.found) return undefined;
    const m: Record<string, "ok" | "missing" | "extra"> = {};
    for (const c of d.controls) {
      m[String(c.controlCode)] = c.status;
    }
    for (const e of d.extraPunches) {
      m[String(e.controlCode)] = "extra";
    }
    return Object.keys(m).length ? m : undefined;
  }, [readout.data]);

  const gpsRoutes = useMemo(() => {
    if (!route.data) return undefined;
    // Single-track previews always render in red regardless of the stored
    // route colour — consistent across cards, and high-contrast against
    // the map background. The per-track colour from `oxygen_routes` is
    // still meaningful in the multi-runner replay view, which doesn't
    // share this code path.
    return [
      {
        color: "#e6194b",
        points: route.data.waypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
      },
    ];
  }, [route.data]);

  // Stable identity for the highlight array so React.memo on the shell-
  // owned MapPanel can skip re-renders when the underlying values are
  // unchanged.
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
