/**
 * Automatic course-overprint cuts.
 *
 * Course setters cut the purple overprint where it would hide a compact
 * knoll or rock point feature. Long line and area objects remain uncut:
 * the IOF colour stack keeps their ink readable without fragmenting the
 * course. This module computes the cuts from the base map's parsed OCAD
 * objects (`event-map-objects.ts`) at geometry-rebuild time, so they are
 * stored in the course GeoJSON and render everywhere.
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
 * Compact ISOM point symbols that receive automatic cuts. Restricting this
 * to point-sized knolls and rocks avoids needless slits over cliffs, paths,
 * buildings, walls and other long objects now handled by colour stacking.
 */
const CUT_SYMBOLS = new Set([
  109, 110, // knoll, elongated knoll
  203, 204, 205, 207, // rocky pit, boulder, large boulder, boulder cluster
]);

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
type Pt = [number, number];

function isCutObject(obj: SlimMapObject): boolean {
  return obj.objType === 1 && CUT_SYMBOLS.has(Math.floor(obj.sym / 1000));
}

/** Object coordinates in paper mm. */
function objectRingsMm(obj: SlimMapObject): Pt[] {
  return obj.coordinates.map(([x, y]) => [
    x / UNITS_PER_MM,
    y / UNITS_PER_MM,
  ]);
}

/** Cheap bbox rejection, `pad` in paper mm around the query point. */
function bboxMiss(obj: SlimMapObject, xMm: number, yMm: number, pad: number): boolean {
  const [minX, minY, maxX, maxY] = obj.bbox;
  const p = pad * UNITS_PER_MM;
  const x = xMm * UNITS_PER_MM;
  const y = yMm * UNITS_PER_MM;
  return x < minX - p || x > maxX + p || y < minY - p || y > maxY + p;
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
 * Automatic slits for a control circle centred at (xMm, yMm): compact
 * knoll and rock point features on the rim.
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

  for (const obj of objects) {
    if (!isCutObject(obj)) continue;
    if (bboxMiss(obj, xMm, yMm, radiusMm + POINT_REACH_MM)) continue;
    const pts = objectRingsMm(obj);
    const p = pts[0];
    if (!p) continue;
    const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
    if (Math.abs(d - radiusMm) <= POINT_REACH_MM) {
      pushSlit(gaps, compassBearing(c, p), pointHalfDeg);
    }
  }

  return mergeArcGaps(gaps);
}

// ─── Leg gaps ────────────────────────────────────────────────

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
 * Automatic gaps for the straight leg a→b (paper mm): compact knoll and
 * rock point features on the line.
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
    if (!isCutObject(obj)) continue;
    if (bboxMiss(obj, midX, midY, reachPad)) continue;
    const pts = objectRingsMm(obj);
    const p = pts[0];
    if (!p) continue;
    const { dist, t } = pointSegDistance(p, aMm, bMm);
    if (dist <= POINT_REACH_MM) pushMm(t, POINT_CUT_HALF_MM);
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
