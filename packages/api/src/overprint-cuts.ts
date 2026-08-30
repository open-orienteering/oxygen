/**
 * Automatic course-overprint cuts.
 *
 * Course setters cut the purple overprint wherever it would hide important
 * map detail: circle slits where a control circle crosses black features
 * (rock, man-made) or knolls, and leg-line gaps where a leg passes over
 * black features. This module computes those cuts from the base map's
 * parsed OCAD objects (`event-map-objects.ts`) at geometry-rebuild time,
 * so they are stored in the course GeoJSON and render everywhere without
 * any manual work.
 *
 * Everything here is pure and unit-tested. Inputs are paper mm (the unit
 * of `controls.xpos/ypos` and course GeoJSON); `SlimMapObject` coordinates
 * are OCAD 1/100 mm units and converted on the fly.
 *
 * Angle convention matches the OCD importer and `drawBrokenCircle` in the
 * viewer: `SlitGap.start/end` are compass bearings in paper space
 * (0° = map north = +y, clockwise), and the *gap* sweeps clockwise from
 * `start` to `end`. Leg gaps are fractions 0..1 along the leg.
 */

import type { SlitGap } from "./iof-course-parser.js";
import type { SlimMapObject } from "./event-map-objects.js";
import { compassBearing } from "./description-autodetect.js";

/** A stretch of a leg line to leave undrawn, as fractions of the leg. */
export interface LegGap {
  from: number;
  to: number;
}

/**
 * ISOM symbols whose ink the overprint must not hide, keyed by ISOM
 * number (`floor(ocadSym / 1000)`).
 *
 * - `point`: compact black point symbols (boulders, towers, cairns …)
 *   plus knolls (109/110 — brown, but small enough that a purple line
 *   over one makes it unreadable).
 * - `line`: black line symbols — cut where the circle rim or leg
 *   *crosses* them.
 * - `area`: solid-black-ish areas (buildings, canopies, ruins, gigantic
 *   boulders) — cut the whole stretch of rim/leg *inside* them.
 *
 * Deliberately excluded: pattern-fill areas (boulder fields, stony
 * ground — their dots are symbol fill, not objects, so a cut at the
 * invisible area boundary would look random), bare rock (grey), paved
 * area (brown fill), and all water / marsh / vegetation symbols.
 */
const CUT_KINDS: Record<number, "point" | "line" | "area"> = {
  // Knolls (brown) — slits only, never leg gaps (see KNOLLS below).
  109: "point", 110: "point",
  // Rock (black).
  201: "line", 202: "line",
  203: "point", 204: "point", 205: "point",
  206: "area", 207: "point",
  215: "line",
  // Man-made (black).
  502: "line", 503: "line", 504: "line", 505: "line", 506: "line",
  507: "line", 508: "line", 509: "line", 510: "line", 511: "line",
  512: "line", 513: "line", 514: "line", 515: "line", 516: "line",
  517: "line", 518: "line",
  521: "area", 522: "area", 523: "area",
  524: "point", 525: "point", 526: "point", 527: "point",
  528: "line", 529: "line",
  530: "point", 531: "point",
  532: "line",
};

/** Knolls cut circles but not legs — a leg over a knoll is convention. */
const KNOLLS = new Set([109, 110]);

/** OCAD units per paper mm (SlimMapObject coordinates). */
const UNITS_PER_MM = 100;

/** Control circle radius the viewer draws, paper mm (2.5 mm ≈ ISOM 5 mm ⌀). */
export const CIRCLE_RADIUS_MM = 2.5;
/**
 * A point feature within this of the rim / leg centreline gets a cut.
 * The overprint stroke is 0.35 mm wide, so it reaches ~0.18 mm either
 * side of the line; a compact ISOM point symbol is ~0.5 mm across. Much
 * beyond 0.45 mm the two no longer touch and a cut would be gratuitous.
 */
const POINT_REACH_MM = 0.45;
/**
 * Half-width of ink cleared around a point feature, paper mm — enough to
 * free the symbol itself plus half the overprint stroke. Cutting wider
 * only fragments the circle without revealing more map.
 */
const POINT_CUT_HALF_MM = 0.4;
/** Half-width of ink to clear around a black line crossing, paper mm. */
const LINE_REACH_MM = 0.35;
/** Rim sampling step for area-interior spans, degrees. */
const AREA_STEP_DEG = 4;
/** Slits narrower than this are dropped (invisible anyway). */
const MIN_SLIT_DEG = 4;
/** If cuts would leave less than this much circle, keep it whole. */
const MAX_TOTAL_SLIT_DEG = 300;
/** Legs keep this much at each end — the viewer clips 1.2 × R anyway. */
const LEG_END_KEEP_MM = 1.2 * CIRCLE_RADIUS_MM;
/** Leg gaps shorter than this are dropped. */
const MIN_LEG_GAP_MM = 0.6;
/** Never gap away more than this fraction of a leg. */
const MAX_TOTAL_LEG_GAP = 0.7;
/** Longest half-gap a single oblique line crossing may open, paper mm. */
const MAX_LINE_HALF_MM = 1.2;

type Pt = [number, number];

function cutKindFor(sym: number): "point" | "line" | "area" | null {
  return CUT_KINDS[Math.floor(sym / 1000)] ?? null;
}

/** Object coordinates in paper mm, closing area rings. */
function objectRingsMm(obj: SlimMapObject): Pt[] {
  const pts: Pt[] = obj.coordinates.map(([x, y]) => [
    x / UNITS_PER_MM,
    y / UNITS_PER_MM,
  ]);
  if (obj.objType === 3 && pts.length > 2) {
    const [fx, fy] = pts[0];
    const [lx, ly] = pts[pts.length - 1];
    if (fx !== lx || fy !== ly) pts.push([fx, fy]);
  }
  return pts;
}

/** Cheap bbox rejection, `pad` in paper mm around the query point. */
function bboxMiss(obj: SlimMapObject, xMm: number, yMm: number, pad: number): boolean {
  const [minX, minY, maxX, maxY] = obj.bbox;
  const p = pad * UNITS_PER_MM;
  const x = xMm * UNITS_PER_MM;
  const y = yMm * UNITS_PER_MM;
  return x < minX - p || x > maxX + p || y < minY - p || y > maxY + p;
}

/** Ray-cast point-in-polygon over a closed ring. */
function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > p[1] !== yj > p[1];
    if (straddles && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Circle slits ────────────────────────────────────────────

interface ArcGap {
  /** Compass degrees, normalized to [0, 360). */
  start: number;
  /** `start + width`; may exceed 360 for gaps wrapping north. */
  end: number;
}

function pushSlit(gaps: ArcGap[], centerDeg: number, halfDeg: number): void {
  const start = (((centerDeg - halfDeg) % 360) + 360) % 360;
  gaps.push({ start, end: start + 2 * halfDeg });
}

/**
 * Merge arc gaps on the circle, dropping slivers and bailing out (full
 * circle) when almost nothing would remain.
 */
function mergeArcGaps(gaps: ArcGap[]): SlitGap[] {
  // Split wrapping gaps so merging is linear over [0, 360].
  const linear: Array<[number, number]> = [];
  for (const g of gaps) {
    if (g.end - g.start >= 360) return []; // degenerate: keep circle whole
    if (g.end > 360) {
      linear.push([g.start, 360]);
      linear.push([0, g.end - 360]);
    } else {
      linear.push([g.start, g.end]);
    }
  }
  linear.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const g of linear) {
    const last = merged[merged.length - 1];
    if (last && g[0] <= last[1]) {
      last[1] = Math.max(last[1], g[1]);
    } else {
      merged.push([g[0], g[1]]);
    }
  }
  // Re-fuse a gap that wraps north so its width survives the MIN filter.
  if (
    merged.length > 1 &&
    merged[0][0] === 0 &&
    merged[merged.length - 1][1] === 360
  ) {
    const tail = merged.pop()!;
    merged[0] = [tail[0], 360 + merged[0][1]];
  }
  const kept = merged.filter(([s, e]) => e - s >= MIN_SLIT_DEG);
  const total = kept.reduce((sum, [s, e]) => sum + (e - s), 0);
  if (total > MAX_TOTAL_SLIT_DEG) return [];
  return kept.map(([s, e]) => ({
    start: s % 360,
    end: e % 360,
  }));
}

/**
 * Intersection angles (compass deg) of segment a→b with the circle of
 * radius r around c.
 */
function segmentCircleCrossings(a: Pt, b: Pt, c: Pt, r: number): number[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const fx = a[0] - c[0];
  const fy = a[1] - c[1];
  const A = dx * dx + dy * dy;
  if (A === 0) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [];
  const sq = Math.sqrt(disc);
  const out: number[] = [];
  for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t < 0 || t > 1) continue;
    const p: Pt = [a[0] + t * dx, a[1] + t * dy];
    out.push(compassBearing(c, p));
  }
  return out;
}

/**
 * Automatic slits for a control circle centred at (xMm, yMm): black point
 * features and knolls on the rim, black line crossings, and rim stretches
 * inside solid black areas.
 */
export function circleCuts(
  objects: SlimMapObject[],
  xMm: number,
  yMm: number,
  radiusMm: number = CIRCLE_RADIUS_MM,
): SlitGap[] {
  const c: Pt = [xMm, yMm];
  const gaps: ArcGap[] = [];
  const pointHalfDeg =
    (Math.asin(Math.min(0.95, POINT_CUT_HALF_MM / radiusMm)) * 180) / Math.PI;
  const lineHalfDeg =
    (Math.asin(Math.min(0.95, LINE_REACH_MM / radiusMm)) * 180) / Math.PI;

  for (const obj of objects) {
    const kind = cutKindFor(obj.sym);
    if (!kind) continue;
    if (bboxMiss(obj, xMm, yMm, radiusMm + POINT_REACH_MM)) continue;
    const pts = objectRingsMm(obj);

    if (kind === "point") {
      const p = pts[0];
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (Math.abs(d - radiusMm) <= POINT_REACH_MM) {
        pushSlit(gaps, compassBearing(c, p), pointHalfDeg);
      }
    } else if (kind === "line") {
      for (let i = 0; i < pts.length - 1; i++) {
        for (const deg of segmentCircleCrossings(pts[i], pts[i + 1], c, radiusMm)) {
          pushSlit(gaps, deg, lineHalfDeg);
        }
      }
    } else {
      if (pts.length < 4) continue;
      // Sample the rim; contiguous inside-runs become one gap each.
      const steps = Math.round(360 / AREA_STEP_DEG);
      const inside: boolean[] = [];
      for (let i = 0; i < steps; i++) {
        const deg = i * AREA_STEP_DEG;
        const rad = (deg * Math.PI) / 180;
        // Compass: 0° = +y (north), clockwise.
        const p: Pt = [c[0] + radiusMm * Math.sin(rad), c[1] + radiusMm * Math.cos(rad)];
        inside.push(pointInRing(p, pts));
      }
      if (inside.every(Boolean)) return []; // whole rim buried: keep circle
      // Walk runs starting from a known-outside sample so wraps are easy.
      const startIdx = inside.findIndex((v) => !v);
      let runStart = -1;
      for (let k = 0; k <= steps; k++) {
        const i = (startIdx + k) % steps;
        if (k < steps && inside[i]) {
          if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
          const runLen = (i - runStart + steps) % steps || steps;
          const startDeg = runStart * AREA_STEP_DEG - AREA_STEP_DEG / 2;
          const width = runLen * AREA_STEP_DEG + AREA_STEP_DEG;
          gaps.push({ start: ((startDeg % 360) + 360) % 360, end: ((startDeg % 360) + 360) % 360 + width });
          runStart = -1;
        }
      }
    }
  }

  return mergeArcGaps(gaps);
}

// ─── Leg gaps ────────────────────────────────────────────────

/** Intersection parameter of leg a→b with segment p→q, or null. */
function segSegIntersection(a: Pt, b: Pt, p: Pt, q: Pt): { t: number; sinAngle: number } | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [q[0] - p[0], q[1] - p[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (denom === 0) return null;
  const qp: Pt = [p[0] - a[0], p[1] - a[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const lenR = Math.hypot(r[0], r[1]);
  const lenS = Math.hypot(s[0], s[1]);
  const sinAngle = lenR && lenS ? Math.abs(denom) / (lenR * lenS) : 1;
  return { t, sinAngle };
}

/** Distance from p to segment a→b plus the projection parameter. */
function pointSegDistance(p: Pt, a: Pt, b: Pt): { dist: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return { dist: Math.hypot(p[0] - cx, p[1] - cy), t };
}

/**
 * Automatic gaps for the straight leg a→b (paper mm): black point
 * features on the line, black line crossings, and stretches inside solid
 * black areas. Knolls are excluded — slits only.
 */
export function legGaps(aMm: Pt, bMm: Pt, objects: SlimMapObject[]): LegGap[] {
  const legLen = Math.hypot(bMm[0] - aMm[0], bMm[1] - aMm[1]);
  if (legLen < 2 * LEG_END_KEEP_MM + MIN_LEG_GAP_MM) return [];

  const midX = (aMm[0] + bMm[0]) / 2;
  const midY = (aMm[1] + bMm[1]) / 2;
  const reachPad = legLen / 2 + POINT_REACH_MM;

  const raw: Array<[number, number]> = [];
  const pushMm = (centerT: number, halfMm: number) => {
    const half = halfMm / legLen;
    raw.push([centerT - half, centerT + half]);
  };

  for (const obj of objects) {
    const isom = Math.floor(obj.sym / 1000);
    if (KNOLLS.has(isom)) continue;
    const kind = cutKindFor(obj.sym);
    if (!kind) continue;
    if (bboxMiss(obj, midX, midY, reachPad)) continue;
    const pts = objectRingsMm(obj);

    if (kind === "point") {
      const { dist, t } = pointSegDistance(pts[0], aMm, bMm);
      if (dist <= POINT_REACH_MM) pushMm(t, POINT_CUT_HALF_MM);
    } else if (kind === "line") {
      for (let i = 0; i < pts.length - 1; i++) {
        const hit = segSegIntersection(aMm, bMm, pts[i], pts[i + 1]);
        if (!hit) continue;
        // Oblique crossings hide a longer stretch of the line.
        const halfMm = Math.min(
          LINE_REACH_MM / Math.max(hit.sinAngle, LINE_REACH_MM / MAX_LINE_HALF_MM),
          MAX_LINE_HALF_MM,
        );
        pushMm(hit.t, halfMm);
      }
    } else {
      if (pts.length < 4) continue;
      // Entry/exit parameters against the ring, toggled from the start
      // point's inside-status.
      const ts: number[] = [0, 1];
      for (let i = 0; i < pts.length - 1; i++) {
        const hit = segSegIntersection(aMm, bMm, pts[i], pts[i + 1]);
        if (hit) ts.push(hit.t);
      }
      ts.sort((x, y) => x - y);
      for (let i = 0; i < ts.length - 1; i++) {
        const lo = ts[i];
        const hi = ts[i + 1];
        if (hi - lo <= 0) continue;
        const mid: Pt = [
          aMm[0] + ((lo + hi) / 2) * (bMm[0] - aMm[0]),
          aMm[1] + ((lo + hi) / 2) * (bMm[1] - aMm[1]),
        ];
        if (pointInRing(mid, pts)) {
          raw.push([lo - LINE_REACH_MM / legLen, hi + LINE_REACH_MM / legLen]);
        }
      }
    }
  }

  if (raw.length === 0) return [];

  // Keep the leg ends the viewer clips around circles anyway.
  const endT = LEG_END_KEEP_MM / legLen;
  const clamped = raw
    .map(([lo, hi]): [number, number] => [Math.max(lo, endT), Math.min(hi, 1 - endT)])
    .filter(([lo, hi]) => hi > lo);
  clamped.sort((x, y) => x[0] - y[0]);

  const merged: Array<[number, number]> = [];
  for (const g of clamped) {
    const last = merged[merged.length - 1];
    if (last && g[0] <= last[1]) {
      last[1] = Math.max(last[1], g[1]);
    } else {
      merged.push([g[0], g[1]]);
    }
  }

  let kept = merged.filter(([lo, hi]) => (hi - lo) * legLen >= MIN_LEG_GAP_MM);
  // Sanity cap: never erase most of a leg — drop the smallest gaps first.
  const total = () => kept.reduce((sum, [lo, hi]) => sum + (hi - lo), 0);
  while (kept.length > 0 && total() > MAX_TOTAL_LEG_GAP) {
    let smallest = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i][1] - kept[i][0] < kept[smallest][1] - kept[smallest][0]) smallest = i;
    }
    kept = kept.filter((_, i) => i !== smallest);
  }

  return kept.map(([from, to]) => ({ from, to }));
}

// ─── Geometry decoration ─────────────────────────────────────

/** Minimal feature-collection shape (matches `GeoJSONFeatureCollection`). */
interface FeatureCollectionLike {
  features: Array<{
    geometry?: { type: string; coordinates: unknown } | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GeoJSON properties are untyped JSONB
    properties?: Record<string, any> | null;
  }>;
}

/**
 * Add automatic `cuts` (control circles) and `gaps` (legs) to an
 * editor-built course geometry, in place. Start and finish symbols are
 * left alone — slits are a circle convention.
 */
export function decorateOverprintCuts(
  geometry: FeatureCollectionLike,
  objects: SlimMapObject[],
): void {
  for (const f of geometry.features) {
    const props = f.properties;
    const geom = f.geometry;
    if (!props || !geom) continue;
    if (props.symbolType === "control" && geom.type === "Point") {
      const [x, y] = geom.coordinates as [number, number];
      const cuts = circleCuts(objects, x, y);
      if (cuts.length > 0) props.cuts = cuts;
      else delete props.cuts;
    } else if (
      props.symbolType === "leg" &&
      geom.type === "LineString" &&
      (geom.coordinates as Pt[]).length === 2
    ) {
      const [a, b] = geom.coordinates as [Pt, Pt];
      const gaps = legGaps(a, b, objects);
      if (gaps.length > 0) props.gaps = gaps;
      else delete props.gaps;
    }
  }
}
