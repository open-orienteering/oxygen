/**
 * Inline fallback map panel for the Tracks page.
 *
 * Used only when there is no .ocd map uploaded for the competition.
 * The common case — .ocd uploaded — is handled by the page-level
 * `<MapSlot>` in `TracksPage`, which drives the shell's persistent
 * MapPanel and so doesn't remount on navigation.
 *
 * This component covers the two remaining cases (called when
 * `hasOcdMap === false`):
 * - The route has a `liveloxClassId` → render the Livelox replay
 *   stack inline at the caller's height.
 * - Otherwise → render a "no map available" placeholder.
 */

import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { trpc } from "../lib/trpc";
import { ReplayMapLayer, type ReplayMapLayerHandle } from "./replay/ReplayMapLayer";
import { ReplayRouteLayer } from "./replay/ReplayRouteLayer";
import { ReplayCourseLayer } from "./replay/ReplayCourseLayer";
import type { ReplayWaypoint } from "@oxygen/shared";

interface RoutePreview {
  color: string;
  raceStartMs: number | null;
  waypoints: ReplayWaypoint[];
  interruptions: number[];
  liveloxClassId: number | null;
  runnerName: string;
  courseName?: string | null;
}

interface Props {
  route: RoutePreview;
  height?: string;
}

export function TrackMapPanel({ route, height = "400px" }: Props) {
  if (!route.liveloxClassId) {
    return (
      <div
        className="flex items-center justify-center bg-slate-100 rounded-lg border border-slate-200 text-slate-400 text-sm"
        style={{ height }}
      >
        No map available
      </div>
    );
  }

  return (
    <LiveloxMapPreview
      route={route}
      liveloxClassId={route.liveloxClassId}
      height={height}
    />
  );
}

// ─── Livelox map fallback ────────────────────────────────────

interface LiveloxMapPreviewProps {
  route: RoutePreview;
  liveloxClassId: number;
  height: string;
}

function LiveloxMapPreview({ route, liveloxClassId, height }: LiveloxMapPreviewProps) {
  const { data, isLoading, error } = trpc.livelox.importClass.useQuery(
    { classId: liveloxClassId },
    { staleTime: 10 * 60_000, retry: 1 },
  );

  const mapRef = useRef<ReplayMapLayerHandle | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const onViewportChange = useCallback(() => {
    setMapReady(true);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height: h } = entries[0].contentRect;
      setContainerSize({ w: width, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build a single-route ReplayData-like structure for the route layer.
  // The single visible track is force-coloured red to match the .ocd map
  // preview path (consistent single-track styling across runners).
  const singleRouteData = useMemo(() => {
    if (!data) return null;
    return {
      ...data,
      routes: data.routes
        .filter((r) => {
          const norm = (s: string) => s.toLowerCase().trim();
          return (
            norm(r.name).includes(norm(route.runnerName.split(" ")[0] ?? "")) ||
            norm(route.runnerName).includes(norm(r.name.split(" ")[0] ?? ""))
          );
        })
        .map((r) => ({ ...r, color: "#e6194b" })),
    };
  }, [data, route.runnerName]);

  const getRouteTime = useCallback(
    (_participantId: string) => {
      // Show the full route (frozen at end)
      return singleRouteData?.routes[0]?.waypoints.at(-1)?.timeMs ?? 0;
    },
    [singleRouteData],
  );

  const visibleParticipants = useMemo(() => {
    const s = new Set<string>();
    singleRouteData?.routes.forEach((r) => s.add(r.participantId));
    return s;
  }, [singleRouteData]);

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200"
        style={{ height }}
      >
        <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        className="flex items-center justify-center bg-slate-100 rounded-lg border border-slate-200 text-slate-400 text-sm"
        style={{ height }}
      >
        Failed to load map
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative rounded-lg overflow-hidden" style={{ height }}>
      <ReplayMapLayer
        ref={mapRef}
        map={data.map}
        onViewportChange={onViewportChange}
        style={{ position: "absolute", inset: 0 }}
      />
      {mapReady && containerSize.w > 0 && singleRouteData && (
        <>
          <ReplayCourseLayer
            data={data}
            mapRef={mapRef}
            containerSize={containerSize}
            primaryFork={data.courses[0] ?? null}
            unionForks={[]}
            activeControlIdx={null}
          />
          <ReplayRouteLayer
            data={singleRouteData}
            mapRef={mapRef}
            containerSize={containerSize}
            getRouteTime={getRouteTime}
            visibleParticipants={visibleParticipants}
          />
        </>
      )}
    </div>
  );
}
