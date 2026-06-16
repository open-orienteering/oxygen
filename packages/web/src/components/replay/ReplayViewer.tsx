/**
 * Main composed replay viewer component.
 *
 * Wires together map, routes, course, playback controls, and participant list
 * into a self-contained viewer that can be embedded in any page.
 *
 * Performance notes
 * -----------------
 * - The current playback time lives in a ref inside `useReplayState` and is
 *   advanced once per frame by the orchestrating RAF below. React state for
 *   `elapsedMs` is updated at ~10 Hz only, so the slider/label stay readable
 *   without re-rendering this component every frame.
 * - The map viewport also lives in a ref inside `ReplayMapLayer`. Overlays
 *   subscribe to viewport changes via `subscribeViewport` and redraw without
 *   forcing a React commit on every drag/zoom/follow tick.
 * - A single orchestrating RAF in this component drives playback time and
 *   the follow-camera lerp. Map/zoom interactions and overlay redraws are
 *   self-coordinated through the subscription buses; this loop only runs
 *   while playback or follow is active.
 */

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type {
  ReplayData,
  ReplayRoute,
  ReplayWaypoint,
  ReplayControl,
  ReplayRelayInfo,
} from "@oxygen/shared";
import {
  ReplayMapLayer,
  type ReplayMapLayerHandle,
} from "./ReplayMapLayer";
import { ReplayRouteLayer } from "./ReplayRouteLayer";
import { ReplayCourseLayer, hitTestControl } from "./ReplayCourseLayer";
import { ReplayHeatmapLayer } from "./ReplayHeatmapLayer";
import { ReplaySpeedTrackLayer } from "./ReplaySpeedTrackLayer";
import { ReplayControls } from "./ReplayControls";
import { ParticipantList } from "./ParticipantList";
import { useReplayState, type ReplayConfig } from "./useReplayState";
import { latLngToMapPx, isOnMap, clampToMap } from "./projection-utils";
import { selectForks } from "./fork-selection";
import { usePerformanceLock } from "../../lib/performance-mode";

const NEARBY_RADIUS_M = 500;

interface Props {
  data: ReplayData;
  compact?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Initial replay configuration (speed, follow, autoPlay, visible runners). */
  replayConfig?: ReplayConfig;
  /** If set, use native OCAD tiles instead of the Livelox map. E.g. "/api/map-tile/my_competition" */
  nativeTileBase?: string;
  /** Routes from other classes, loaded on demand for nearby mode. */
  extraRoutes?: ReplayRoute[];
  /** True while other-class route data is still loading. */
  extraRoutesLoading?: boolean;
  /** Called when the user toggles nearby mode on/off. */
  onNearbyModeChange?: (active: boolean) => void;
  /** Relay leg metadata; when more than one leg, a leg switcher is shown. */
  relay?: ReplayRelayInfo;
  /** Currently selected relay leg (1-based); defaults to `relay.currentLeg`. */
  currentLeg?: number;
  /** Called when the user picks a different relay leg. */
  onLegChange?: (leg: number) => void;
  /** True while a newly selected leg is still loading. */
  legLoading?: boolean;
}

/** Binary search for waypoint index at or before timeMs. */
function findWpIdx(wps: { timeMs: number }[], t: number): number {
  let lo = 0, hi = wps.length - 1;
  if (hi < 0 || t < wps[0].timeMs) return -1;
  if (t >= wps[hi].timeMs) return hi;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (wps[m].timeMs <= t) lo = m; else hi = m - 1; }
  return lo;
}

/** Interpolate between two waypoints — same as the route layer's logic so
 *  the follow-all camera tracks the actual rendered dot, not the last raw
 *  GPS sample (which makes the camera judder between segments). */
function interpolateWp(
  wps: ReplayWaypoint[],
  idx: number,
  t: number,
): { lat: number; lng: number } {
  const a = wps[idx];
  if (idx >= wps.length - 1) return { lat: a.lat, lng: a.lng };
  const b = wps[idx + 1];
  if (b.timeMs <= a.timeMs || t <= a.timeMs) return { lat: a.lat, lng: a.lng };
  if (t >= b.timeMs) return { lat: b.lat, lng: b.lng };
  const frac = (t - a.timeMs) / (b.timeMs - a.timeMs);
  return {
    lat: a.lat + (b.lat - a.lat) * frac,
    lng: a.lng + (b.lng - a.lng) * frac,
  };
}

export function ReplayViewer({ data, compact, className, style, replayConfig, nativeTileBase, extraRoutes, extraRoutesLoading, onNearbyModeChange, relay, currentLeg, onLegChange, legLoading }: Props) {
  const state = useReplayState(data, replayConfig);

  // Pause shell-side background polls (counter probe, DB stats, queue
  // refresh, version check, kiosk ping) only while playback is actually
  // running — their periodic React commits compete with the orchestrator
  // RAF and cause 1-2 frame stutters every few seconds. When the user
  // pauses or playback ends, the lock is released and the header
  // indicators in the surrounding shell pick up live updates again.
  usePerformanceLock(state.isPlaying);
  const allParticipants = useMemo(
    () => new Set(data.routes.map((r) => r.participantId)),
    [data.routes],
  );

  // ── Forked-course selection ──
  const isForked = data.courses.length > 1;
  const forkByParticipant = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data.routes) if (r.courseId) m.set(r.participantId, r.courseId);
    return m;
  }, [data.routes]);
  const [showAllForks, setShowAllForks] = useState(false);
  // Reset the overlay when a new dataset (e.g. another leg) loads.
  useEffect(() => {
    setShowAllForks(false);
  }, [data]);
  const { primaryFork, unionForks, unionFaint } = useMemo(
    () => selectForks(data.courses, forkByParticipant, state.visibleParticipants, showAllForks),
    [data.courses, forkByParticipant, state.visibleParticipants, showAllForks],
  );

  const mapRef = useRef<ReplayMapLayerHandle | null>(null);
  // We don't store the viewport in React state — it lives in mapRef. We do
  // need a "ready" flag so overlay components only mount once the map's
  // imperative handle is populated and the initial fit-to-bounds has fired.
  const [mapReady, setMapReady] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [sidebarOpen, setSidebarOpen] = useState(!compact);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showTracks, setShowTracks] = useState(false);
  const [nearbyMode, setNearbyMode] = useState(false);

  // The single target runner when nearby mode is active
  const nearbyTargetId = nearbyMode && state.visibleParticipants.size === 1
    ? [...state.visibleParticipants][0]
    : null;

  const handleNearbyToggle = useCallback(() => {
    const next = !nearbyMode;
    setNearbyMode(next);
    onNearbyModeChange?.(next);
  }, [nearbyMode, onNearbyModeChange]);

  // Auto-disable nearby mode if selection changes away from exactly 1 runner
  useEffect(() => {
    if (nearbyMode && state.visibleParticipants.size !== 1) {
      setNearbyMode(false);
      onNearbyModeChange?.(false);
    }
  }, [nearbyMode, state.visibleParticipants.size, onNearbyModeChange]);
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

  // Fired by ReplayMapLayer on every viewport change (initial fit, drag,
  // zoom, follow). We use it solely as a "map is ready" signal — the
  // viewport itself is read via mapRef in overlays + orchestrator.
  const onViewportChange = useCallback(() => {
    setMapReady(true);
  }, []);

  // ─── Orchestrating RAF ───────────────────────────────────────
  // Drives:
  //   1. playback time (advances elapsedRef inside useReplayState)
  //   2. follow-all and nearby-follow camera lerps (mutate map viewport)
  // Other concerns coordinate themselves:
  //   - Map redraws happen inside ReplayMapLayer when viewport changes.
  //   - Overlays subscribe to viewport + time pubs and redraw on demand.
  //   - The wheel zoom spring keeps its own RAF inside ReplayMapLayer.
  //
  // The loop only runs when there's per-frame work to do (playing or
  // following). When nothing is happening, the main thread sleeps.

  // Refs for state values that need to be read each frame without
  // re-creating the orchestrator on every change.
  const isPlayingRef = useRef(state.isPlaying);
  const followModeRef = useRef(state.followMode);
  const nearbyTargetIdRef = useRef<string | null>(nearbyTargetId);
  const visibleParticipantsRef = useRef(state.visibleParticipants);
  const containerWRef = useRef(containerSize.w);
  const containerHRef = useRef(containerSize.h);
  const startModeRef = useRef(state.startMode);
  const currentLegRef = useRef(state.currentLeg);
  useEffect(() => { isPlayingRef.current = state.isPlaying; }, [state.isPlaying]);
  useEffect(() => { followModeRef.current = state.followMode; }, [state.followMode]);
  useEffect(() => { nearbyTargetIdRef.current = nearbyTargetId; }, [nearbyTargetId]);
  useEffect(() => { visibleParticipantsRef.current = state.visibleParticipants; }, [state.visibleParticipants]);
  useEffect(() => { containerWRef.current = containerSize.w; }, [containerSize.w]);
  useEffect(() => { containerHRef.current = containerSize.h; }, [containerSize.h]);
  useEffect(() => { startModeRef.current = state.startMode; }, [state.startMode]);
  useEffect(() => { currentLegRef.current = state.currentLeg; }, [state.currentLeg]);

  // Stable refs for state methods (these are stable across renders already
  // but storing them in a ref keeps the orchestrator effect dep-free).
  const advanceTimeRef = useRef(state.advanceTime);
  const getRouteTimeRef = useRef(state.getRouteTime);
  useEffect(() => { advanceTimeRef.current = state.advanceTime; }, [state.advanceTime]);
  useEffect(() => { getRouteTimeRef.current = state.getRouteTime; }, [state.getRouteTime]);

  useEffect(() => {
    let raf = 0;
    let lastNow = performance.now();
    let stopped = false;

    // Hoisted out of the per-frame tick: looking up the target route via
    // `data.routes.find(...)` is O(n) and the result is constant within
    // this effect's lifetime.
    const targetRoute = nearbyTargetId
      ? data.routes.find((r) => r.participantId === nearbyTargetId) ?? null
      : null;
    const proj = data.map.projection;
    const mapW = data.map.widthPx;
    const mapH = data.map.heightPx;

    // Each runner may have run a different fork, so smart-follow indexes its
    // "next un-punched control" against THAT runner's fork (via courseId),
    // falling back to the first course for non-forked events.
    const courseByIdLocal = new Map(data.courses.map((c) => [c.id, c]));
    const fallbackControls = data.courses[0]?.controls ?? [];
    const controlsByRoute: ReplayControl[][] = data.routes.map(
      (route) =>
        (route.courseId ? courseByIdLocal.get(route.courseId)?.controls : undefined) ??
        fallbackControls,
    );

    // Pre-compute per-route, per-control absolute split times so smart
    // follow can find each runner's next un-punched control without
    // walking splitTimes every frame. Indexed [routeIdx][ctrlIdx]; null
    // when no split exists for that control (e.g. start, missed punches).
    const splitTimesByRoute: (number | null)[][] = data.routes.map((route, ri) => {
      const ctrls = controlsByRoute[ri];
      const start = route.raceStartMs ?? route.waypoints[0]?.timeMs ?? 0;
      return ctrls.map((ctrl) => {
        const split = route.result?.splitTimes?.find(
          (s) => s.controlCode === ctrl.code,
        );
        return split !== undefined ? start + split.timeMs : null;
      });
    });

    // Control circle "extent" in map pixels — used to expand the bbox so
    // the entire control symbol (not just its centre) is always inside
    // the camera frame, with a one-diameter buffer for breathing room.
    // Mirrors the radius the course layer actually draws:
    //   controlRadius_screenPx = 2.5 * ss = 2.5 * (mapScale/1000) * resolution * vp.scale
    // → controlRadius_mapPx    = 2.5 * (mapScale/1000) * resolution   (no vp.scale).
    const projMatrix = data.map.projection.matrix;
    const projResolution = Math.sqrt(
      (projMatrix[0] * projMatrix[0] + projMatrix[3] * projMatrix[3] +
        projMatrix[1] * projMatrix[1] + projMatrix[4] * projMatrix[4]) / 2,
    );
    const ctrlRadiusMapPx = 2.5 * ((data.map.mapScale ?? 15000) / 1000) * projResolution;
    // Extent = radius + one full diameter as margin.
    const ctrlExtentMapPx = ctrlRadiusMapPx + 2 * ctrlRadiusMapPx;

    /**
     * Returns the index of the next un-punched course control for a given
     * route at runner-clock time `t`. The start (index 0) is treated as
     * already passed once the runner has begun, so the very first call
     * returns 1 (the first real control).
     */
    const nextControlIdx = (routeIdx: number, t: number): number => {
      const ctrls = controlsByRoute[routeIdx];
      if (ctrls.length === 0) return -1;
      let lastDone = 0;
      const splits = splitTimesByRoute[routeIdx];
      for (let i = 1; i < ctrls.length; i++) {
        const splitT = splits[i];
        if (splitT !== null && splitT <= t) {
          lastDone = i;
        }
      }
      return Math.min(lastDone + 1, ctrls.length - 1);
    };

    const tick = (now: number) => {
      if (stopped) return;
      const dt = Math.min(now - lastNow, 100); // cap dt in case of tab-switch hiccup
      lastNow = now;

      // 1. Advance playback time.
      if (isPlayingRef.current) {
        advanceTimeRef.current(dt);
      }

      // 2. Step follow camera. "all" pans the bbox of current runner
      //    positions; "smart" additionally widens the bbox to include
      //    each runner's next un-punched control AND lerps the zoom
      //    level to fit, so the camera always frames the relevant
      //    action without losing the destination.
      const followMode = followModeRef.current;
      const target = nearbyTargetIdRef.current;
      const containerW = containerWRef.current;
      const containerH = containerHRef.current;
      if (
        (followMode === "all" || followMode === "smart") &&
        !target &&
        containerW > 0 &&
        containerH > 0
      ) {
        const handle = mapRef.current;
        const vp = handle?.getViewport();
        if (handle && vp) {
          const visible = visibleParticipantsRef.current;
          const isSmart = followMode === "smart";
          // In legs mode, every runner shares the same destination
          // (controls[currentLeg + 1]). Pre-compute it once so we don't
          // repeat the per-runner next-control lookup pointlessly.
          const isLegsMode = startModeRef.current === "legs";
          const legsTargetIdx = isLegsMode && fallbackControls.length > 1
            ? Math.min(currentLegRef.current + 1, fallbackControls.length - 1)
            : -1;

          let minMx = Infinity, maxMx = -Infinity, minMy = Infinity, maxMy = -Infinity;
          let count = 0;
          for (let r = 0; r < data.routes.length; r++) {
            const route = data.routes[r];
            if (!visible.has(route.participantId)) continue;
            if (route.waypoints.length === 0) continue;
            const t = getRouteTimeRef.current(route.participantId);
            const idx = findWpIdx(route.waypoints, t);
            if (idx < 0) continue;
            const pos = interpolateWp(route.waypoints, idx, t);
            const { px, py } = latLngToMapPx(pos.lat, pos.lng, proj);
            // Ignore positions far outside the map: a single bad sample must
            // not blow up the bbox and fling the camera off the map. If every
            // visible runner is off-map, count stays 0 and the camera holds
            // its current (fit) position instead of chasing garbage.
            if (!isOnMap(px, py, mapW, mapH)) continue;
            if (px < minMx) minMx = px;
            if (px > maxMx) maxMx = px;
            if (py < minMy) minMy = py;
            if (py > maxMy) maxMy = py;
            count++;

            if (isSmart) {
              const ctrls = controlsByRoute[r];
              const ctrlIdx = isLegsMode
                ? legsTargetIdx
                : nextControlIdx(r, t);
              if (ctrlIdx >= 0 && ctrlIdx < ctrls.length) {
                const ctrl = ctrls[ctrlIdx];
                const { px: cPx, py: cPy } = latLngToMapPx(ctrl.lat, ctrl.lng, proj);
                // Expand by the control symbol's radius + one diameter
                // margin so the entire circle stays in frame, not just
                // its centre point. Skip controls that project off-map.
                if (isOnMap(cPx, cPy, mapW, mapH)) {
                  if (cPx - ctrlExtentMapPx < minMx) minMx = cPx - ctrlExtentMapPx;
                  if (cPx + ctrlExtentMapPx > maxMx) maxMx = cPx + ctrlExtentMapPx;
                  if (cPy - ctrlExtentMapPx < minMy) minMy = cPy - ctrlExtentMapPx;
                  if (cPy + ctrlExtentMapPx > maxMy) maxMy = cPy + ctrlExtentMapPx;
                }
              }
            }
          }

          if (count > 0) {
            // Clamp the bbox centre to the map: even if smart-mode control
            // expansion or a near-edge cluster pushes it out, the camera
            // target stays on the image.
            const { cx, cy } = clampToMap(
              (minMx + maxMx) / 2,
              (minMy + maxMy) / 2,
              mapW,
              mapH,
            );
            const PAN_SPEED = 1.5; // 1/seconds — exponential lerp
            const alphaPan = 1 - Math.exp(-PAN_SPEED * dt / 1000);
            const newCx = vp.cx + (cx - vp.cx) * alphaPan;
            const newCy = vp.cy + (cy - vp.cy) * alphaPan;

            let newScale = vp.scale;
            if (isSmart) {
              // Compute the largest scale that fits the bbox + 25%
              // padding inside the viewport. Floor the bbox dims so a
              // single point doesn't blow scale up to infinity, and
              // clamp scale to the same range the wheel-zoom uses.
              const bboxW = Math.max(maxMx - minMx, 1);
              const bboxH = Math.max(maxMy - minMy, 1);
              const padding = 1.25;
              const fitScaleX = containerW / (bboxW * padding);
              const fitScaleY = containerH / (bboxH * padding);
              const targetScale = Math.max(
                0.05,
                Math.min(8, Math.min(fitScaleX, fitScaleY)),
              );
              // Log-space lerp gives perceptually uniform zoom motion —
              // a 2x→4x change feels the same speed as 1x→2x.
              const ZOOM_SPEED = 1.2;
              const alphaZoom = 1 - Math.exp(-ZOOM_SPEED * dt / 1000);
              newScale = Math.exp(
                Math.log(vp.scale) +
                  (Math.log(targetScale) - Math.log(vp.scale)) * alphaZoom,
              );
            }

            handle.setViewport({ ...vp, cx: newCx, cy: newCy, scale: newScale });
          }
        }
      }

      // 3. Step nearby-follow camera (track the single selected runner).
      if (target && targetRoute && targetRoute.waypoints.length > 0) {
        const handle = mapRef.current;
        const vp = handle?.getViewport();
        if (handle && vp) {
          const t = getRouteTimeRef.current(target);
          const idx = findWpIdx(targetRoute.waypoints, t);
          if (idx >= 0) {
            const pos = interpolateWp(targetRoute.waypoints, idx, t);
            const { px, py } = latLngToMapPx(pos.lat, pos.lng, proj);
            // Skip a bad sample rather than jumping the camera off the map.
            if (isOnMap(px, py, mapW, mapH)) {
              const LERP_SPEED = 2.0;
              const alpha = 1 - Math.exp(-LERP_SPEED * dt / 1000);
              const { cx, cy } = clampToMap(px, py, mapW, mapH);
              handle.setViewport({
                ...vp,
                cx: vp.cx + (cx - vp.cx) * alpha,
                cy: vp.cy + (cy - vp.cy) * alpha,
              });
            }
          }
        }
      }

      raf = requestAnimationFrame(tick);
    };

    // Only start the loop when there's per-frame work. When everything
    // settles (paused, no follow), the main thread can idle entirely.
    const followActive = state.followMode === "all" || state.followMode === "smart";
    if (state.isPlaying || (followActive && !nearbyTargetId) || nearbyTargetId) {
      lastNow = performance.now();
      raf = requestAnimationFrame(tick);
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [state.isPlaying, state.followMode, nearbyTargetId, data]);

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
      const vp = mapRef.current?.getViewport();
      if (!vp) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Restart-from-control needs a single shared course to index into. For
      // forked relay legs each runner ran a different fork, so we disable it
      // there (clicks just toggle play) and only hit-test the lone course.
      const hitFork = isForked ? null : data.courses[0] ?? null;
      const idx = hitTestControl(x, y, hitFork, data, vp, containerSize);
      if (idx >= 0) {
        state.restartFromControl(state.restartControlIdx === idx ? null : idx);
      } else {
        state.togglePlay();
      }
    },
    [containerSize, data, isForked, state.restartFromControl, state.restartControlIdx, state.togglePlay], // eslint-disable-line react-hooks/exhaustive-deps -- state methods are stable
  );

  return (
    <div
      className={`flex flex-col bg-white ${className ?? ""}`}
      style={{ height: "100%", ...style }}
    >
      {/* Title bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-slate-50 border-b border-slate-200">
        <h2 className="text-slate-900 text-sm font-semibold truncate min-w-0">
          {data.title}
        </h2>

        {/* Relay leg switcher */}
        {relay && relay.legs.length > 1 && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className="text-xs text-slate-500 mr-0.5">Leg</span>
            {relay.legs.map((l) => {
              const isCurrent = (currentLeg ?? relay.currentLeg) === l.leg;
              return (
                <button
                  key={l.leg}
                  onClick={() => !isCurrent && onLegChange?.(l.leg)}
                  disabled={isCurrent}
                  title={`Leg ${l.name} — ${l.participantCount} runners`}
                  className={`text-xs w-7 h-6 rounded border transition-colors ${
                    isCurrent
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "text-slate-600 hover:text-slate-900 border-slate-300 cursor-pointer"
                  }`}
                >
                  {l.name}
                </button>
              );
            })}
            {legLoading && (
              <span className="w-3.5 h-3.5 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin ml-1" />
            )}
          </div>
        )}

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-slate-500">
            {data.routes.length} routes
          </span>
          {isForked && (
            <button
              onClick={() => setShowAllForks((v) => !v)}
              title="Overlay all forked course variants"
              className={`text-xs px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                showAllForks
                  ? "bg-purple-600 border-purple-600 text-white"
                  : "text-slate-500 hover:text-slate-900 border-slate-300"
              }`}
            >
              All forks
            </button>
          )}
          <button
            onClick={() => setShowTracks((t) => !t)}
            title="Lay out full speed-coloured tracks for the selected runners"
            className={`text-xs px-2 py-0.5 rounded border transition-colors cursor-pointer ${
              showTracks
                ? "bg-cyan-600 border-cyan-600 text-white"
                : "text-slate-500 hover:text-slate-900 border-slate-300"
            }`}
          >
            Tracks
          </button>
          <button
            onClick={() => setShowHeatmap((h) => !h)}
            title="Toggle heatmap overlay"
            className={`text-xs px-2 py-0.5 rounded border transition-colors cursor-pointer ${
              showHeatmap
                ? "bg-orange-500 border-orange-500 text-white"
                : "text-slate-500 hover:text-slate-900 border-slate-300"
            }`}
          >
            Heatmap
          </button>
          <button
            onClick={handleNearbyToggle}
            disabled={!nearbyMode && state.visibleParticipants.size !== 1}
            title={
              state.visibleParticipants.size !== 1 && !nearbyMode
                ? "Select exactly one runner to enable nearby mode"
                : "Show all runners within 500 m of the selected runner"
            }
            className={`text-xs px-2 py-0.5 rounded border transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
              nearbyMode
                ? "bg-blue-600 border-blue-600 text-white"
                : "text-slate-500 hover:text-slate-900 border-slate-300"
            }`}
          >
            {nearbyMode && extraRoutesLoading ? "Nearby…" : "Nearby"}
          </button>
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
            nativeTileBase={nativeTileBase}
          />
          {mapReady && containerSize.w > 0 && showHeatmap && (
            <ReplayHeatmapLayer
              data={data}
              mapRef={mapRef}
              containerSize={containerSize}
              visibleParticipants={allParticipants}
            />
          )}
          {mapReady && containerSize.w > 0 && showTracks && (
            <ReplaySpeedTrackLayer
              data={data}
              mapRef={mapRef}
              containerSize={containerSize}
              visibleParticipants={state.visibleParticipants}
            />
          )}
          {mapReady && containerSize.w > 0 && (
            <>
              <ReplayCourseLayer
                data={data}
                mapRef={mapRef}
                containerSize={containerSize}
                primaryFork={primaryFork}
                unionForks={unionForks}
                unionFaint={unionFaint}
                activeControlIdx={state.restartControlIdx}
              />
              <ReplayRouteLayer
                data={data}
                mapRef={mapRef}
                containerSize={containerSize}
                getRouteTime={state.getRouteTime}
                subscribeElapsed={state.subscribeElapsed}
                visibleParticipants={state.visibleParticipants}
                playbackSpeed={state.speed}
                extraRoutes={nearbyTargetId ? extraRoutes : undefined}
                nearbyFilter={nearbyTargetId ? { targetId: nearbyTargetId, radiusM: NEARBY_RADIUS_M } : undefined}
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
