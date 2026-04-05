/**
 * Canvas overlay that draws animated GPS routes on top of the map layer.
 *
 * Each visible route is drawn as a coloured trail with a moving dot at the
 * current playback time. The trail has a configurable tail length (default 60s).
 */

import { useRef, useEffect, useCallback } from "react";
import type { ReplayData, ReplayRoute, ReplayWaypoint } from "@oxygen/shared";
import type { ViewportState } from "./ReplayMapLayer";
import { latLngToMapPx } from "./projection-utils";

interface Props {
  data: ReplayData;
  viewport: ViewportState | null;
  containerSize: { w: number; h: number };
  getRouteTime: (participantId: string) => number;
  visibleParticipants: Set<string>;
  /** Tail length in milliseconds (default 60000 = 60 s of real time). */
  tailLengthMs?: number;
  /** Current playback speed multiplier (used to keep pulse animation duration constant in real time). */
  playbackSpeed?: number;
}

const DEFAULT_TAIL_MS = 60_000;
const BASE_LINE_WIDTH = 4;
const BASE_DOT_RADIUS = 6;
const BASE_LABEL_SIZE = 11;

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

export function ReplayRouteLayer({
  data,
  viewport,
  containerSize,
  getRouteTime,
  visibleParticipants,
  tailLengthMs = DEFAULT_TAIL_MS,
  playbackSpeed = 1,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerSize.w * dpr;
    canvas.height = containerSize.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
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

    for (const route of data.routes) {
      if (!visibleParticipants.has(route.participantId)) continue;
      if (route.waypoints.length < 2) continue;

      const routeTime = getRouteTime(route.participantId);
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

      // Draw tail as a single path with uniform opacity
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
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
  }, [data, viewport, containerSize, getRouteTime, visibleParticipants, tailLengthMs, playbackSpeed]);

  // Redraw on every animation frame when playing
  useEffect(() => {
    const tick = () => {
      draw();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

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
}
