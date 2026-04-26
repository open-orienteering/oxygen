/**
 * Canvas overlay that renders a density heatmap of all visible routes.
 *
 * Performance: all routes are pre-rendered once into an offscreen canvas in
 * map-pixel space. Each frame only blits that offscreen canvas with the current
 * viewport transform — no per-frame route iteration.
 *
 * Uses additive blending ('lighter') so overlapping routes accumulate into
 * bright hot-spots, giving a clear picture of where the field ran.
 */

import { useRef, useEffect, useCallback, useMemo } from "react";
import type { ReplayData } from "@oxygen/shared";
import type { ReplayMapLayerHandle } from "./ReplayMapLayer";
import { latLngToMapPx } from "./projection-utils";

interface Props {
  data: ReplayData;
  /** Imperative handle to the map layer, used to read the live viewport. */
  mapRef: React.RefObject<ReplayMapLayerHandle | null>;
  containerSize: { w: number; h: number };
  visibleParticipants: Set<string>;
}

/** Build an offscreen canvas with all routes drawn in map-pixel space. */
function buildOffscreen(
  data: ReplayData,
  visibleParticipants: Set<string>,
): HTMLCanvasElement {
  const { widthPx, heightPx, projection: proj } = data.map;
  const oc = document.createElement("canvas");
  oc.width = widthPx;
  oc.height = heightPx;
  const ctx = oc.getContext("2d")!;

  const n = visibleParticipants.size;
  // Scale alpha so overlapping areas saturate while individual routes are visible.
  // Few runners → higher alpha per route; many runners → lower to preserve density contrast.
  const alpha = Math.min(0.9, Math.max(0.03, 2.0 / n));

  // Compute a scale-appropriate line width in map pixels.
  // Uses same formula as ReplayRouteLayer but without vp.scale (applied by blit transform).
  const [a, b, , c, d] = proj.matrix;
  const resolution = Math.sqrt((a * a + c * c + b * b + d * d) / 2);
  const mapScale = data.map.mapScale ?? 15000;
  const lineWidth = Math.max(2, (mapScale / 1000) * resolution * 0.5);

  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = `rgba(255, 130, 20, ${alpha})`;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const route of data.routes) {
    if (!visibleParticipants.has(route.participantId)) continue;
    if (route.waypoints.length < 2) continue;

    const interruptSet = new Set(route.interruptions);

    ctx.beginPath();
    let penDown = false;
    for (let i = 0; i < route.waypoints.length; i++) {
      const wp = route.waypoints[i];
      const { px, py } = latLngToMapPx(wp.lat, wp.lng, proj);

      if (!penDown || interruptSet.has(i)) {
        ctx.moveTo(px, py);
        penDown = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  return oc;
}

export function ReplayHeatmapLayer({
  data,
  mapRef,
  containerSize,
  visibleParticipants,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastCanvasDimsRef = useRef({ w: 0, h: 0 });

  // Rebuild offscreen only when the set of visible participants or data changes.
  // Sorted key ensures stable identity regardless of Set insertion order.
  const participantKey = useMemo(
    () => [...visibleParticipants].sort().join(","),
    [visibleParticipants],
  );

  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenKeyRef = useRef<string>("");

  // Blit offscreen to screen using viewport transform — no route iteration.
  const draw = useCallback(() => {
    // Rebuild offscreen if participants changed
    if (offscreenKeyRef.current !== participantKey) {
      offscreenRef.current = buildOffscreen(data, visibleParticipants);
      offscreenKeyRef.current = participantKey;
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
  }, [data, visibleParticipants, participantKey, mapRef, containerSize]);

  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  // Subscribe to viewport changes so the heatmap pans/zooms with the map
  // without going through React state.
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
