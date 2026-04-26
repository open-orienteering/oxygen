/**
 * Canvas overlay that draws the course (controls + connecting lines) on the map.
 * Controls are sized according to IOF norms and scale correctly with zoom.
 * Course lines are clipped around control circles (no lines through circles).
 * Control labels are placed to avoid overlapping controls and lines.
 */

import { useRef, useEffect, useCallback } from "react";
import type { ReplayData, ReplayControl } from "@oxygen/shared";
import type { ReplayMapLayerHandle, ViewportState } from "./ReplayMapLayer";
import { latLngToMapPx } from "./projection-utils";

interface Props {
  data: ReplayData;
  /** Imperative handle to the map layer, used to read the live viewport. */
  mapRef: React.RefObject<ReplayMapLayerHandle | null>;
  containerSize: { w: number; h: number };
  activeControlIdx?: number | null;
}

const COURSE_COLOR = "#d000d0";
const ACTIVE_COLOR = "#ff6600";

interface Pt { x: number; y: number }

// ─── clipLine: clip a line segment around control circles ───

function clipLine(
  a: Pt, b: Pt,
  obstacles: Pt[],
  clearance: number,
): { x1: number; y1: number; x2: number; y2: number }[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return [];
  const ux = dx / len, uy = dy / len;

  const blocks: [number, number][] = [];
  for (const obs of obstacles) {
    const vx = obs.x - a.x, vy = obs.y - a.y;
    const t = vx * ux + vy * uy;
    const px = a.x + t * ux - obs.x;
    const py = a.y + t * uy - obs.y;
    const perpDist = Math.sqrt(px * px + py * py);
    if (perpDist < clearance) {
      const half = Math.sqrt(clearance * clearance - perpDist * perpDist);
      blocks.push([t - half, t + half]);
    }
  }

  blocks.sort((ba, bb) => ba[0] - bb[0]);
  const merged: [number, number][] = [];
  for (const bl of blocks) {
    if (merged.length > 0 && bl[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], bl[1]);
    } else {
      merged.push([bl[0], bl[1]]);
    }
  }

  const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let cursor = 0;
  for (const [bs, be] of merged) {
    const s0 = Math.max(cursor, 0);
    const s1 = Math.min(bs, len);
    if (s1 - s0 > 1) {
      segs.push({ x1: a.x + s0 * ux, y1: a.y + s0 * uy, x2: a.x + s1 * ux, y2: a.y + s1 * uy });
    }
    cursor = be;
  }
  const s0 = Math.max(cursor, 0);
  if (len - s0 > 1) {
    segs.push({ x1: a.x + s0 * ux, y1: a.y + s0 * uy, x2: a.x + len * ux, y2: a.y + len * uy });
  }
  return segs;
}

// ─── Smart label placement ──────────────────────────────────

function ptSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const LABEL_OFFSETS = [
  { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
  { dx: 0, dy: -1 }, { dx: -1, dy: -1 }, { dx: -1, dy: 0 },
  { dx: -1, dy: 1 }, { dx: 0, dy: 1 },
  { dx: 1.3, dy: -0.7 }, { dx: -1.3, dy: -0.7 },
];

function findBestLabelPos(
  pos: Pt,
  radius: number,
  estW: number,
  estH: number,
  allCirclePts: Pt[],
  allLineSegs: { x1: number; y1: number; x2: number; y2: number }[],
  labelPositions: { x: number; y: number; w: number; h: number }[],
): Pt {
  let bestPos = { x: pos.x + radius * 1.3, y: pos.y - radius * 0.5 };
  let bestCost = Infinity;

  for (const off of LABEL_OFFSETS) {
    const candX = pos.x + off.dx * (radius + estW * 0.55);
    const candY = pos.y + off.dy * (radius + estH * 0.55);
    const candRect = { x: candX - estW / 2, y: candY - estH / 2, w: estW, h: estH };

    let cost = 0;
    for (const cp of allCirclePts) {
      if (cp === pos) continue;
      const d = Math.hypot(candX - cp.x, candY - cp.y);
      if (d < radius * 2) cost += 100;
      else if (d < radius * 3) cost += 20;
    }
    for (const lp of labelPositions) {
      if (candRect.x < lp.x + lp.w && candRect.x + candRect.w > lp.x &&
          candRect.y < lp.y + lp.h && candRect.y + candRect.h > lp.y) {
        cost += 50;
      }
    }
    for (const seg of allLineSegs) {
      const dist = ptSegDist(candX, candY, seg.x1, seg.y1, seg.x2, seg.y2);
      if (dist < estH) cost += 30;
    }
    if (off.dx < 0) cost += 2;
    if (off.dy > 0) cost += 1;

    if (cost < bestCost) { bestCost = cost; bestPos = { x: candX, y: candY }; }
  }

  labelPositions.push({ x: bestPos.x - estW / 2, y: bestPos.y - estH / 2, w: estW, h: estH });
  return bestPos;
}

// ─── Symbol scale computation ───────────────────────────────

function computeSymbolScale(
  mapScale: number | undefined,
  viewportScale: number,
  projectionMatrix: number[],
): number {
  if (mapScale) {
    const [a, b, , c, d] = projectionMatrix;
    const resolution = Math.sqrt((a * a + c * c + b * b + d * d) / 2);
    return (mapScale / 1000) * resolution * viewportScale;
  }
  return viewportScale * 0.8;
}

// ─── Hit test (exported for use in ReplayViewer) ────────────

export function hitTestControl(
  x: number,
  y: number,
  data: ReplayData,
  viewport: ViewportState,
  containerSize: { w: number; h: number },
): number {
  if (data.courses.length === 0) return -1;
  const proj = data.map.projection;
  const vp = viewport;
  const cos = Math.cos(vp.rotation);
  const sin = Math.sin(vp.rotation);
  const halfW = containerSize.w / 2;
  const halfH = containerSize.h / 2;
  const hitRadius = 20;

  for (let i = 0; i < data.courses[0].controls.length; i++) {
    const ctrl = data.courses[0].controls[i];
    const { px, py } = latLngToMapPx(ctrl.lat, ctrl.lng, proj);
    const dx = (px - vp.cx) * vp.scale;
    const dy = (py - vp.cy) * vp.scale;
    const sx = cos * dx - sin * dy + halfW;
    const sy = sin * dx + cos * dy + halfH;
    const ddx = x - sx;
    const ddy = y - sy;
    if (ddx * ddx + ddy * ddy < hitRadius * hitRadius) return i;
  }
  return -1;
}

// ─── Component ──────────────────────────────────────────────

export function ReplayCourseLayer({
  data,
  mapRef,
  containerSize,
  activeControlIdx,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastCanvasDimsRef = useRef({ w: 0, h: 0 });

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

    if (data.courses.length === 0) return;

    const proj = data.map.projection;
    const vp = viewport;
    const cos = Math.cos(vp.rotation);
    const sin = Math.sin(vp.rotation);
    const halfW = containerSize.w / 2;
    const halfH = containerSize.h / 2;

    const ss = computeSymbolScale(data.map.mapScale, vp.scale, proj.matrix);

    const toScreen = (mx: number, my: number): Pt => {
      const dx = (mx - vp.cx) * vp.scale;
      const dy = (my - vp.cy) * vp.scale;
      return {
        x: cos * dx - sin * dy + halfW,
        y: sin * dx + cos * dy + halfH,
      };
    };

    const controlToScreen = (ctrl: ReplayControl): Pt => {
      const { px, py } = latLngToMapPx(ctrl.lat, ctrl.lng, proj);
      return toScreen(px, py);
    };

    const course = data.courses[0];

    // IOF sizes
    const controlRadius = 2.5 * ss;
    const strokeWidth = Math.max(0.5, 0.35 * ss);
    const startSize = 3.5 * ss;
    const finishInner = 2.0 * ss;
    const finishOuter = 3.0 * ss;
    const labelSize = Math.max(8, 3.5 * ss);
    const lineStroke = Math.max(0.5, 0.35 * ss);

    // Compute all control screen positions
    const screenPts: Pt[] = course.controls.map(controlToScreen);
    const obstacles: Pt[] = [...screenPts];

    // ── Draw course lines (clipped around controls) ──
    ctx.strokeStyle = COURSE_COLOR;
    ctx.lineWidth = lineStroke;

    const allLineSegs: { x1: number; y1: number; x2: number; y2: number }[] = [];

    for (let i = 0; i < course.controls.length - 1; i++) {
      const segs = clipLine(screenPts[i], screenPts[i + 1], obstacles, controlRadius * 1.2);
      for (const seg of segs) {
        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
        allLineSegs.push(seg);
      }
    }

    // ── Draw control symbols ──
    const labelPositions: { x: number; y: number; w: number; h: number }[] = [];

    // Precompute sequence numbers (1…N) for "control" type only
    let seqCounter = 0;
    const seqNums: number[] = course.controls.map((c) =>
      c.type === "control" ? ++seqCounter : 0,
    );

    for (let i = 0; i < course.controls.length; i++) {
      const ctrl = course.controls[i];
      const pos = screenPts[i];

      const isActive = activeControlIdx === i;
      ctx.strokeStyle = isActive ? ACTIVE_COLOR : COURSE_COLOR;
      ctx.lineWidth = isActive ? strokeWidth * 2 : strokeWidth;

      if (ctrl.type === "start") {
        const s = startSize;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - s);
        ctx.lineTo(pos.x - s * 0.866, pos.y + s * 0.5);
        ctx.lineTo(pos.x + s * 0.866, pos.y + s * 0.5);
        ctx.closePath();
        ctx.stroke();
      } else if (ctrl.type === "finish") {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, finishOuter, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, finishInner, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, controlRadius, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Smart label placement for regular controls
      if (ctrl.type === "control") {
        const label = String(seqNums[i]);
        const estW = label.length * labelSize * 0.65;
        const estH = labelSize * 1.2;
        const labelPos = findBestLabelPos(
          pos, controlRadius, estW, estH,
          obstacles, allLineSegs, labelPositions,
        );

        ctx.font = `bold ${Math.round(labelSize)}px Inter, sans-serif`;
        ctx.fillStyle = isActive ? ACTIVE_COLOR : COURSE_COLOR;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, labelPos.x, labelPos.y);
      }
    }
  }, [data, mapRef, containerSize, activeControlIdx]);

  // Always read the latest draw fn from a ref so the viewport subscription
  // doesn't have to re-attach on every prop change.
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  // Subscribe to viewport changes (drag, zoom, follow updates).
  useEffect(() => {
    const handle = mapRef.current;
    if (!handle) return;
    drawRef.current();
    return handle.subscribeViewport(() => drawRef.current());
  }, [mapRef]);

  // Redraw on structural changes (data, activeControlIdx, container size).
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

