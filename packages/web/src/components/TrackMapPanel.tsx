/**
 * Unified map panel for displaying a GPS route preview.
 *
 * - If an O2 map is uploaded: renders the O2 map via MapPanel with the GPS
 *   track overlaid as a coloured polyline.
 * - If no O2 map: renders the Livelox map + route via the replay components,
 *   loading on-demand using the Livelox class ID.
 */

import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { trpc } from "../lib/trpc";
import { MapPanel } from "./MapPanel";
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

/** Convert stored waypoints to the gpsRoutes format expected by MapPanel/MapViewer. */
function toGpsRoute(route: RoutePreview) {
  return [
    {
      color: route.color || "#e6194b",
      points: route.waypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
    },
  ];
}

export function TrackMapPanel({ route, height = "400px" }: Props) {
  // Check whether an O2 map exists
  const mapMetadata = trpc.course.mapMetadata.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  const hasMap = mapMetadata.data != null;
  const isLoadingMap = mapMetadata.isLoading;

  if (isLoadingMap) {
    return (
      <div
        className="flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200"
        style={{ height }}
      >
        <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (hasMap) {
    // O2 map available — overlay the GPS track
    return (
      <MapPanel
        height={height}
        fitToControls={false}
        hideToolbar
        gpsRoutes={toGpsRoute(route)}
        highlightCourseName={route.courseName ?? undefined}
      />
    );
  }

  // No O2 map — use Livelox map if we have a class ID
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

  // Build a single-route ReplayData-like structure for the route layer
  const singleRouteData = useMemo(() => {
    if (!data) return null;
    return {
      ...data,
      routes: data.routes.filter((r) => {
        // Match by name (best effort)
        const norm = (s: string) => s.toLowerCase().trim();
        return norm(r.name).includes(norm(route.runnerName.split(" ")[0] ?? "")) ||
               norm(route.runnerName).includes(norm(r.name.split(" ")[0] ?? ""));
      }),
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
