/**
 * Canvas overlay that draws animated GPS routes on top of the map layer.
 *
 * Each visible route is drawn as a coloured trail with a moving dot at the
 * current playback time. The trail has a configurable tail length (default 60s).
 *
 * Performance: this component does NOT consume the viewport or current time
 * via React props. It reads them from refs (the map's `subscribeViewport`
 * bus, and the replay state's `subscribeElapsed` bus) and redraws to its own
 * canvas without forcing a React commit on every frame.
 */

import { forwardRef, useImperativeHandle, useRef, useEffect, useCallback, useMemo } from "react";
import type { ReplayData, ReplayRoute, ReplayWaypoint } from "@oxygen/shared";
import type { ReplayMapLayerHandle } from "./ReplayMapLayer";
import { latLngToMapPx } from "./projection-utils";

interface NearbyFilter {
  targetId: string;
  radiusM: number;
}

interface Props {
  data: ReplayData;
  /** Imperative handle to the map layer, used to read the live viewport. */
  mapRef: React.RefObject<ReplayMapLayerHandle | null>;
  containerSize: { w: number; h: number };
  getRouteTime: (participantId: string) => number;
  /** Subscribe to time changes (called by useReplayState's pub/sub). */
  subscribeElapsed?: (cb: () => void) => () => void;
  visibleParticipants: Set<string>;
  /** Tail length in milliseconds (default 60000 = 60 s of real time). */
  tailLengthMs?: number;
  /** Current playback speed multiplier (used to keep pulse animation duration constant in real time). */
  playbackSpeed?: number;
  /** Routes from other classes, shown in nearby mode. */
  extraRoutes?: ReplayRoute[];
  /** When set, only routes within radiusM of the target are drawn; extraRoutes included. */
  nearbyFilter?: NearbyFilter;
}

export interface ReplayRouteLayerHandle {
  /** Imperatively redraw — used by the orchestrating RAF in ReplayViewer. */
  redraw: () => void;
}

/** Approximate distance in metres between two lat/lng points. */
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 111320;
  const dLng = (lng2 - lng1) * 111320 * Math.cos((lat1 + lat2) * Math.PI / 360);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

const DEFAULT_TAIL_MS = 60_000;

/** Binary search for the waypoint index at or just before `timeMs`. */
function findWaypointIndex(
  waypoints: ReplayWaypoint[],
  timeMs: number,
): number {
  let lo = 0;
  let hi = waypoints.length - 1;
  if (hi < 0 || timeMs < waypoints[0].timeMs) return -1;
  if (timeMs >= waypoints[hi].timeMs) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (waypoints[mid].timeMs <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Interpolate position between two waypoints. */
function interpolatePosition(
  a: ReplayWaypoint,
  b: ReplayWaypoint,
  timeMs: number,
): { lat: number; lng: number } {
  if (a.timeMs === b.timeMs) return { lat: a.lat, lng: a.lng };
  const t = (timeMs - a.timeMs) / (b.timeMs - a.timeMs);
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

export const ReplayRouteLayer = forwardRef<ReplayRouteLayerHandle, Props>(
  function ReplayRouteLayer(
    {
      data,
      mapRef,
      containerSize,
      getRouteTime,
      subscribeElapsed,
      visibleParticipants,
      tailLengthMs = DEFAULT_TAIL_MS,
      playbackSpeed = 1,
      extraRoutes,
      nearbyFilter,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const lastCanvasDimsRef = useRef({ w: 0, h: 0 });

    // Stable set of extra-route participantIds for O(1) lookup
    const extraIds = useMemo(
      () => new Set((extraRoutes ?? []).map((r) => r.participantId)),
      [extraRoutes],
    );

    const draw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const viewport = mapRef.current?.getViewport();
      if (!viewport) return;

      const dpr = window.devicePixelRatio || 1;
      const wPx = containerSize.w * dpr;
      const hPx = containerSize.h * dpr;
      if (lastCanvasDimsRef.current.w !== wPx || lastCanvasDimsRef.current.h !== hPx) {
        canvas.width = wPx;
        canvas.height = hPx;
        lastCanvasDimsRef.current = { w: wPx, h: hPx };
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, containerSize.w, containerSize.h);

      const proj = data.map.projection;
      const vp = viewport;
      const cos = Math.cos(vp.rotation);
      const sin = Math.sin(vp.rotation);
      const halfW = containerSize.w / 2;
      const halfH = containerSize.h / 2;

      // Compute scale-aware sizes: sizes should stay constant relative to the map
      const [a, b, , c, d] = proj.matrix;
      const resolution = Math.sqrt((a * a + c * c + b * b + d * d) / 2);
      const mapScale = data.map.mapScale ?? 15000;
      const ss = (mapScale / 1000) * resolution * vp.scale;
      const lineWidth = Math.max(1.5, 0.4 * ss);
      const dotRadius = Math.max(3, 0.5 * ss);
      const labelSize = Math.max(8, 0.45 * ss);

      // Helper: map pixel → screen pixel (inlined for perf)
      const toScreen = (mx: number, my: number) => {
        const dx = (mx - vp.cx) * vp.scale;
        const dy = (my - vp.cy) * vp.scale;
        return {
          sx: cos * dx - sin * dy + halfW,
          sy: sin * dx + cos * dy + halfH,
        };
      };

      // In nearby mode: combine primary routes + extra routes; find target position
      const allRoutes: ReplayRoute[] = nearbyFilter
        ? [...data.routes, ...(extraRoutes ?? [])]
        : data.routes;

      let nearbyTargetLat: number | null = null;
      let nearbyTargetLng: number | null = null;
      if (nearbyFilter) {
        const tr = data.routes.find((r) => r.participantId === nearbyFilter.targetId);
        if (tr) {
          const t = getRouteTime(nearbyFilter.targetId);
          const idx = findWaypointIndex(tr.waypoints, t);
          if (idx >= 0) {
            const wp = tr.waypoints[idx];
            if (idx < tr.waypoints.length - 1 && t > wp.timeMs) {
              const pos = interpolatePosition(wp, tr.waypoints[idx + 1], t);
              nearbyTargetLat = pos.lat; nearbyTargetLng = pos.lng;
            } else {
              nearbyTargetLat = wp.lat; nearbyTargetLng = wp.lng;
            }
          }
        }
      }

      for (const route of allRoutes) {
        // Visibility: in nearby mode show all routes within radius; otherwise respect selection
        if (nearbyFilter) {
          if (route.participantId !== nearbyFilter.targetId) {
            // Skip if target position not yet known
            if (nearbyTargetLat === null) continue;
            // Get this route's position at the same wall time as the target
            const t = extraIds.has(route.participantId)
              ? getRouteTime(nearbyFilter.targetId) // extra routes use target's wall time
              : getRouteTime(route.participantId);
            const idx = findWaypointIndex(route.waypoints, t);
            if (idx < 0) continue;
            const wp = route.waypoints[idx];
            if (distanceM(nearbyTargetLat!, nearbyTargetLng!, wp.lat, wp.lng) > nearbyFilter.radiusM) continue;
          }
        } else {
          if (!visibleParticipants.has(route.participantId)) continue;
        }
        if (route.waypoints.length < 2) continue;

        // Extra-class routes use the target's current wall time for playback position
        const routeTime = extraIds.has(route.participantId) && nearbyFilter
          ? getRouteTime(nearbyFilter.targetId)
          : getRouteTime(route.participantId);
        const currentIdx = findWaypointIndex(route.waypoints, routeTime);
        if (currentIdx < 0) continue; // Route hasn't started yet

        const tailStartTime = routeTime - tailLengthMs;
        const tailStartRaw = findWaypointIndex(route.waypoints, tailStartTime);
        const tailStartIdx = Math.max(0, tailStartRaw);

        const color = route.color ?? "#e6194b";

        // Build interruption set for quick lookup
        const interruptionSet = new Set(route.interruptions);

        // Compute the interpolated tail start point for smooth tail beginning
        let tailStartPt: { sx: number; sy: number } | null = null;
        if (tailStartIdx > 0 && tailStartRaw >= 0) {
          const wpA = route.waypoints[tailStartIdx];
          const wpB = route.waypoints[Math.min(tailStartIdx + 1, route.waypoints.length - 1)];
          if (wpA && wpB && wpB.timeMs > wpA.timeMs) {
            const tailPos = interpolatePosition(wpA, wpB, tailStartTime);
            const { px, py } = latLngToMapPx(tailPos.lat, tailPos.lng, proj);
            tailStartPt = toScreen(px, py);
          }
        }

        // Draw tail as individual segments with fading opacity (smooth disappearing tail)
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        // Collect points from tail start to current
        const tailPoints: { sx: number; sy: number; timeMs: number; interrupt: boolean }[] = [];
        if (tailStartPt) {
          tailPoints.push({ ...tailStartPt, timeMs: tailStartTime, interrupt: false });
        }
        // When tailStartPt is set, it already represents the start of segment
        // [tailStartIdx → tailStartIdx+1]. Skip tailStartIdx to avoid a backward
        // segment from the interpolated point back to the raw waypoint.
        const loopStart = tailStartPt ? tailStartIdx + 1 : tailStartIdx;
        for (let i = loopStart; i <= currentIdx; i++) {
          const wp = route.waypoints[i];
          const { px, py } = latLngToMapPx(wp.lat, wp.lng, proj);
          const { sx, sy } = toScreen(px, py);
          tailPoints.push({ sx, sy, timeMs: wp.timeMs, interrupt: interruptionSet.has(i) });
        }
        // Add interpolated current position at front
        if (currentIdx < route.waypoints.length - 1 && routeTime > route.waypoints[currentIdx].timeMs) {
          const pos = interpolatePosition(
            route.waypoints[currentIdx],
            route.waypoints[currentIdx + 1],
            routeTime,
          );
          const { px, py } = latLngToMapPx(pos.lat, pos.lng, proj);
          const { sx, sy } = toScreen(px, py);
          tailPoints.push({ sx, sy, timeMs: routeTime, interrupt: false });
        }

        const isExtra = extraIds.has(route.participantId);

        // Draw tail as a single path with uniform opacity
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.globalAlpha = isExtra ? 0.5 : 0.8;
        for (let i = 1; i < tailPoints.length; i++) {
          const pt = tailPoints[i];
          if (pt.interrupt) continue;
          const prev = tailPoints[i - 1];
          ctx.moveTo(prev.sx, prev.sy);
          ctx.lineTo(pt.sx, pt.sy);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Draw current position dot
        let dotLat: number, dotLng: number;
        if (
          currentIdx < route.waypoints.length - 1 &&
          routeTime > route.waypoints[currentIdx].timeMs
        ) {
          const pos = interpolatePosition(
            route.waypoints[currentIdx],
            route.waypoints[currentIdx + 1],
            routeTime,
          );
          dotLat = pos.lat;
          dotLng = pos.lng;
        } else {
          dotLat = route.waypoints[currentIdx].lat;
          dotLng = route.waypoints[currentIdx].lng;
        }

        const { px: dotPx, py: dotPy } = latLngToMapPx(dotLat, dotLng, proj);
        const { sx: dotSx, sy: dotSy } = toScreen(dotPx, dotPy);

        ctx.beginPath();
        ctx.arc(dotSx, dotSy, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = Math.max(1, dotRadius * 0.25);
        ctx.stroke();

        // Name label
        const fontSize = Math.round(labelSize);
        ctx.font = `bold ${fontSize}px Inter, sans-serif`;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, fontSize * 0.25);
        const label = route.name.split(" ")[1] ?? route.name; // Last name
        const labelOffset = dotRadius + 4;
        ctx.strokeText(label, dotSx + labelOffset, dotSy + fontSize * 0.35);
        ctx.fillText(label, dotSx + labelOffset, dotSy + fontSize * 0.35);

        // Punch pulse effect — triggered by split times.
        // Use raceStartMs as the base so times align with getRouteTime.
        // Only pulse if the runner is actively moving (not frozen at a control).
        if (route.result?.splitTimes) {
          const raceStart = route.raceStartMs ?? route.waypoints[0].timeMs;
          // Scale by sqrt(speed) so the animation stays visible at high speeds
          // without covering entire legs. Capped at 8000ms route-time.
          const PULSE_DURATION = Math.min(8000, 3000 * Math.sqrt(Math.max(1, playbackSpeed)));
          // Detect frozen state: check if next waypoint time > routeTime
          const nextWp = route.waypoints[Math.min(currentIdx + 1, route.waypoints.length - 1)];
          const isFrozen = currentIdx >= route.waypoints.length - 1 || nextWp.timeMs <= routeTime;

          for (const split of route.result.splitTimes) {
            const punchTime = raceStart + split.timeMs;
            const timeSincePunch = routeTime - punchTime;
            // Animate on approach: fire in the window just BEFORE the punch so the
            // animation completes at the moment of freeze (legs mode) rather than
            // at the restart of the next leg.
            if (timeSincePunch > -PULSE_DURATION && timeSincePunch < 0 && !isFrozen) {
              const progress = (timeSincePunch + PULSE_DURATION) / PULSE_DURATION; // 0→1
              const pulseRadius = dotRadius * (1.5 + progress * 3);
              const alpha = 1 - progress;
              ctx.beginPath();
              ctx.arc(dotSx, dotSy, pulseRadius, 0, Math.PI * 2);
              ctx.strokeStyle = color;
              ctx.lineWidth = Math.max(1.5, dotRadius * 0.3);
              ctx.globalAlpha = alpha * 0.7;
              ctx.stroke();
              ctx.globalAlpha = 1;
            }
          }
        }
      }
    }, [data, mapRef, containerSize, getRouteTime, visibleParticipants, tailLengthMs, playbackSpeed, extraRoutes, extraIds, nearbyFilter]);

    // Always keep the latest draw fn in a ref so subscriptions see the
    // freshest closure without re-subscribing on every prop change.
    const drawRef = useRef(draw);
    useEffect(() => {
      drawRef.current = draw;
    }, [draw]);

    // Coalesce redraws within a single task: during playback the orchestrator
    // notifies both `elapsed` and `viewport` subscribers in the same RAF
    // tick. Both should produce a single draw, not two — the route draw is
    // the heaviest overlay and doubling it bursts the frame budget. A
    // queued microtask collapses any number of sync notifications in the
    // current task into one synchronous draw at task end.
    const drawScheduledRef = useRef(false);
    const scheduleDraw = useCallback(() => {
      if (drawScheduledRef.current) return;
      drawScheduledRef.current = true;
      queueMicrotask(() => {
        drawScheduledRef.current = false;
        drawRef.current();
      });
    }, []);

    // Subscribe to viewport changes (drag, zoom, follow updates) so the
    // overlay re-renders without a parent React commit.
    useEffect(() => {
      const handle = mapRef.current;
      if (!handle) return;
      // Initial draw once map ready.
      drawRef.current();
      const unsub = handle.subscribeViewport(scheduleDraw);
      return unsub;
    }, [mapRef, scheduleDraw]);

    // Subscribe to time changes (replay state pub/sub). When playing, this
    // fires every animation frame.
    useEffect(() => {
      if (!subscribeElapsed) return;
      return subscribeElapsed(scheduleDraw);
    }, [subscribeElapsed, scheduleDraw]);

    // Redraw on structural changes (data/visibleParticipants/etc.).
    useEffect(() => {
      drawRef.current();
    }, [draw]);

    useImperativeHandle(ref, () => ({
      redraw: () => drawRef.current(),
    }), []);

    return (
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    );
  },
);
