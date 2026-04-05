/**
 * Main composed replay viewer component.
 *
 * Wires together map, routes, course, playback controls, and participant list
 * into a self-contained viewer that can be embedded in any page.
 */

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { ReplayData } from "@oxygen/shared";
import {
  ReplayMapLayer,
  type ReplayMapLayerHandle,
  type ViewportState,
} from "./ReplayMapLayer";
import { ReplayRouteLayer } from "./ReplayRouteLayer";
import { ReplayCourseLayer, hitTestControl } from "./ReplayCourseLayer";
import { ReplayControls } from "./ReplayControls";
import { ParticipantList } from "./ParticipantList";
import { useReplayState, type ReplayConfig } from "./useReplayState";
import { latLngToMapPx } from "./projection-utils";

interface Props {
  data: ReplayData;
  compact?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Initial replay configuration (speed, follow, autoPlay, visible runners). */
  replayConfig?: ReplayConfig;
}

/** Binary search for waypoint index at or before timeMs. */
function findWpIdx(wps: { timeMs: number }[], t: number): number {
  let lo = 0, hi = wps.length - 1;
  if (hi < 0 || t < wps[0].timeMs) return -1;
  if (t >= wps[hi].timeMs) return hi;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (wps[m].timeMs <= t) lo = m; else hi = m - 1; }
  return lo;
}

export function ReplayViewer({ data, compact, className, style, replayConfig }: Props) {
  const state = useReplayState(data, replayConfig);
  const mapRef = useRef<ReplayMapLayerHandle>(null);
  const [viewport, setViewport] = useState<ViewportState | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [sidebarOpen, setSidebarOpen] = useState(!compact);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track the map container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onViewportChange = useCallback((vp: ViewportState) => {
    setViewport({ ...vp });
  }, []);

  // Auto-pan: rAF-based loop with delta-time lerp for smooth following
  const followRafRef = useRef<number>(0);
  const followLastFrameRef = useRef<number>(0);

  useEffect(() => {
    if (state.followMode !== "all") {
      cancelAnimationFrame(followRafRef.current);
      return;
    }

    const LERP_SPEED = 1.5; // higher = faster convergence (units: 1/second)

    const tick = (now: number) => {
      const dt = Math.min((now - followLastFrameRef.current) / 1000, 0.1); // seconds, capped
      followLastFrameRef.current = now;

      const vp = mapRef.current?.getViewport();
      if (!vp || containerSize.w === 0) {
        followRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const proj = data.map.projection;
      let minMx = Infinity, maxMx = -Infinity, minMy = Infinity, maxMy = -Infinity;
      let count = 0;

      for (const route of data.routes) {
        if (!state.visibleParticipants.has(route.participantId)) continue;
        if (route.waypoints.length === 0) continue;
        const t = state.getRouteTime(route.participantId);
        const idx = findWpIdx(route.waypoints, t);
        if (idx < 0) continue;
        const wp = route.waypoints[idx];
        const { px, py } = latLngToMapPx(wp.lat, wp.lng, proj);
        if (px < minMx) minMx = px;
        if (px > maxMx) maxMx = px;
        if (py < minMy) minMy = py;
        if (py > maxMy) maxMy = py;
        count++;
      }

      if (count > 0) {
        const cx = (minMx + maxMx) / 2;
        const cy = (minMy + maxMy) / 2;

        // Exponential lerp: smooth regardless of framerate. Only lerp cx/cy,
        // letting the user control scale freely with the scroll wheel.
        const alpha = 1 - Math.exp(-LERP_SPEED * dt);
        const newCx = vp.cx + (cx - vp.cx) * alpha;
        const newCy = vp.cy + (cy - vp.cy) * alpha;

        mapRef.current?.setViewport?.({ ...vp, cx: newCx, cy: newCy });
      }

      followRafRef.current = requestAnimationFrame(tick);
    };

    followLastFrameRef.current = performance.now();
    followRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(followRafRef.current);
  }, [state.followMode, state.visibleParticipants, state.getRouteTime, data, containerSize]);

  // Click on map area — check if a control was hit (only for true clicks, not drags)
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);

  const onMapPointerDown = useCallback((e: React.PointerEvent) => {
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onMapClick = useCallback(
    (e: React.MouseEvent) => {
      // Only treat as click if pointer didn't move much (not a drag)
      if (pointerDownPos.current) {
        const dx = e.clientX - pointerDownPos.current.x;
        const dy = e.clientY - pointerDownPos.current.y;
        if (dx * dx + dy * dy > 25) return; // was a drag
      }
      if (!viewport) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const idx = hitTestControl(x, y, data, viewport, containerSize);
      if (idx >= 0) {
        state.restartFromControl(state.restartControlIdx === idx ? null : idx);
      } else {
        state.togglePlay();
      }
    },
    [viewport, containerSize, data, state.restartFromControl, state.restartControlIdx, state.togglePlay],
  );

  return (
    <div
      className={`flex flex-col bg-white ${className ?? ""}`}
      style={{ height: "100%", ...style }}
    >
      {/* Title bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200">
        <h2 className="text-slate-900 text-sm font-semibold truncate">
          {data.title}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {data.routes.length} routes
          </span>
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="text-slate-500 hover:text-slate-900 transition-colors text-xs px-2 py-0.5 rounded border border-slate-300 cursor-pointer"
          >
            {sidebarOpen ? "Hide list" : "Show list"}
          </button>
        </div>
      </div>

      {/* Main content: map + optional sidebar */}
      <div className="flex-1 flex min-h-0">
        {/* Map area */}
        <div
          ref={containerRef}
          className="flex-1 relative min-w-0 min-h-[400px]"
          onPointerDown={onMapPointerDown}
          onClick={onMapClick}
        >
          <ReplayMapLayer
            ref={mapRef}
            map={data.map}
            onViewportChange={onViewportChange}
            style={{ position: "absolute", inset: 0 }}
          />
          {viewport && containerSize.w > 0 && (
            <>
              <ReplayCourseLayer
                data={data}
                viewport={viewport}
                containerSize={containerSize}
                activeControlIdx={state.restartControlIdx}
              />
              <ReplayRouteLayer
                data={data}
                viewport={viewport}
                containerSize={containerSize}
                getRouteTime={state.getRouteTime}
                visibleParticipants={state.visibleParticipants}
                playbackSpeed={state.speed}
              />
            </>
          )}
        </div>

        {/* Participant sidebar */}
        {sidebarOpen && (
          <div className="w-72 border-l border-slate-200 flex-shrink-0">
            <ParticipantList
              routes={data.routes}
              visibleParticipants={state.visibleParticipants}
              toggleParticipant={state.toggleParticipant}
              showAll={state.showAll}
              hideAll={state.hideAll}
              showOnly={state.showOnly}
            />
          </div>
        )}
      </div>

      {/* Controls bar */}
      <ReplayControls state={state} />
    </div>
  );
}
