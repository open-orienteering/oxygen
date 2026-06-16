/**
 * Canvas overlay that lays out each visible runner's WHOLE route as a static,
 * speed-coloured polyline with periodic time ticks — an analysis view that
 * complements the live playback dots rather than animating.
 *
 * Colour: a cool ramp (deep blue -> cyan -> green) computed in `speed-color.ts`,
 * a separate colour range from the warm orange heatmap so the two overlays stay
 * legible when stacked. This layer never touches the heatmap's colouring.
 *
 * Performance: like ReplayHeatmapLayer, the whole track is pre-rendered once
 * into an offscreen canvas in map-pixel space; each frame only blits that
 * canvas with the current viewport transform. Because the track is static it
 * does NOT subscribe to the elapsed-time bus — only to viewport changes.
 */

import { useRef, useEffect, useCallback, useMemo } from "react";
import type { ReplayData } from "@oxygen/shared";
import type { ReplayMapLayerHandle } from "./ReplayMapLayer";
import { latLngToMapPx } from "./projection-utils";
import {
  computeSmoothedSpeeds,
  normalizeSpeeds,
  speedColor,
  tickPositions,
  DEFAULT_TICK_INTERVAL_MS,
} from "./speed-color";

interface Props {
  data: ReplayData;
  /** Imperative handle to the map layer, used to read the live viewport. */
  mapRef: React.RefObject<ReplayMapLayerHandle | null>;
  containerSize: { w: number; h: number };
  visibleParticipants: Set<string>;
  /** Spacing between time ticks in milliseconds (default 60 s). */
  tickIntervalMs?: number;
}

/** Build an offscreen canvas with every visible speed-coloured track in map-pixel space. */
function buildOffscreen(
  data: ReplayData,
  visibleParticipants: Set<string>,
  tickIntervalMs: number,
): HTMLCanvasElement {
  const { widthPx, heightPx, projection: proj } = data.map;
  const oc = document.createElement("canvas");
  oc.width = widthPx;
  oc.height = heightPx;
  const ctx = oc.getContext("2d")!;

  // Scale-appropriate sizes in map pixels (vp.scale is applied by the blit).
  const [a, b, , c, d] = proj.matrix;
  const resolution = Math.sqrt((a * a + c * c + b * b + d * d) / 2);
  const mapScale = data.map.mapScale ?? 15000;
  const lineWidth = Math.max(3, (mapScale / 1000) * resolution * 0.7);
  const tickRadius = Math.max(2.5, lineWidth * 0.8);

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const route of data.routes) {
    if (!visibleParticipants.has(route.participantId)) continue;
    if (route.waypoints.length < 2) continue;

    const interruptSet = new Set(route.interruptions);
    const pts = route.waypoints.map((wp) => latLngToMapPx(wp.lat, wp.lng, proj));
    const norm = normalizeSpeeds(
      computeSmoothedSpeeds(route.waypoints, route.interruptions),
    );

    // Dark underlay for contrast against the orange heatmap / map detail.
    ctx.strokeStyle = "rgba(15, 23, 42, 0.5)";
    ctx.lineWidth = lineWidth * 1.7;
    ctx.beginPath();
    let penDown = false;
    for (let i = 0; i < pts.length; i++) {
      if (!penDown || interruptSet.has(i)) {
        ctx.moveTo(pts[i].px, pts[i].py);
        penDown = true;
      } else {
        ctx.lineTo(pts[i].px, pts[i].py);
      }
    }
    ctx.stroke();

    // Speed-coloured segments on top.
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = 0.95;
    for (let i = 1; i < pts.length; i++) {
      if (interruptSet.has(i)) continue; // signal gap: leave a break
      const sa = norm[i - 1];
      const sb = norm[i];
      const t =
        Number.isFinite(sa) && Number.isFinite(sb)
          ? (sa + sb) / 2
          : Number.isFinite(sa)
            ? sa
            : Number.isFinite(sb)
              ? sb
              : 0;
      ctx.strokeStyle = speedColor(t);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].px, pts[i - 1].py);
      ctx.lineTo(pts[i].px, pts[i].py);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Time ticks: spacing reveals pace (close = slow, far apart = fast).
    const ticks = tickPositions(route.waypoints, route.interruptions, tickIntervalMs);
    ctx.lineWidth = Math.max(0.5, tickRadius * 0.35);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.85)";
    ctx.fillStyle = "#ffffff";
    for (const tick of ticks) {
      const { px, py } = latLngToMapPx(tick.lat, tick.lng, proj);
      ctx.beginPath();
      ctx.arc(px, py, tickRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  return oc;
}

export function ReplaySpeedTrackLayer({
  data,
  mapRef,
  containerSize,
  visibleParticipants,
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastCanvasDimsRef = useRef({ w: 0, h: 0 });

  // Rebuild offscreen only when the visible set or data changes.
  // Sorted key ensures stable identity regardless of Set insertion order.
  const participantKey = useMemo(
    () => [...visibleParticipants].sort().join(","),
    [visibleParticipants],
  );

  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenKeyRef = useRef<string>("");

  const draw = useCallback(() => {
    const rebuildKey = `${participantKey}|${tickIntervalMs}`;
    if (offscreenKeyRef.current !== rebuildKey) {
      offscreenRef.current = buildOffscreen(data, visibleParticipants, tickIntervalMs);
      offscreenKeyRef.current = rebuildKey;
    }

    const oc = offscreenRef.current;
    const canvas = canvasRef.current;
    if (!oc || !canvas || containerSize.w === 0) return;
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

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const vp = viewport;
    const cos = Math.cos(vp.rotation);
    const sin = Math.sin(vp.rotation);
    const s = vp.scale * dpr;
    const cw = containerSize.w;
    const ch = containerSize.h;

    // Full transform: map pixel → screen pixel (includes DPR scaling)
    ctx.setTransform(
      cos * s, sin * s,
      -sin * s, cos * s,
      (-cos * vp.cx * vp.scale + sin * vp.cy * vp.scale + cw / 2) * dpr,
      (-sin * vp.cx * vp.scale - cos * vp.cy * vp.scale + ch / 2) * dpr,
    );
    ctx.drawImage(oc, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [data, visibleParticipants, participantKey, tickIntervalMs, mapRef, containerSize]);

  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  // Subscribe to viewport changes so the track pans/zooms with the map without
  // going through React state. No elapsed subscription — the track is static.
  useEffect(() => {
    const handle = mapRef.current;
    if (!handle) return;
    drawRef.current();
    return handle.subscribeViewport(() => drawRef.current());
  }, [mapRef]);

  // Redraw on structural changes (data, participants, container size).
  useEffect(() => {
    drawRef.current();
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
