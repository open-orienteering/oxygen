/**
 * Control-description autodetect: rank the base-map features around a
 * point and propose IOF description columns D (feature) and G (side of).
 *
 * Pure and unit-tested. The caller supplies the searchable objects from
 * `event-map-objects.ts` and a query point in paper mm; ISOM → column-D
 * translation comes from `ISOM_DESCRIPTION_MAP` in `@oxygen/shared`.
 *
 * Scope (v1): point features, plus simple lines and areas. Deliberately
 * out of scope — they need information the map does not carry, or logic
 * that would guess: column C (which of several), column F
 * (junction/crossing), between-features, and column E dimensions.
 */

import { isomDescriptionFor, isomNumber } from "@oxygen/shared";
import type { SlimMapObject } from "./event-map-objects.js";

export interface DescriptionCandidate {
  /** Canonical OCAD column-D code, e.g. "2.004" (boulder). */
  d: string;
  /** Canonical OCAD column-G code (side of), when a direction applies. */
  g?: string;
  /** ISOM symbol number the suggestion came from, e.g. 204. */
  isom: number;
  /** Distance from the query point to the feature, in paper mm. */
  distanceMm: number;
}

export interface SuggestOptions {
  /** Search radius in paper mm. Default 3 mm ≈ one control circle. */
  radiusMm?: number;
  /** Maximum number of candidates. Default 3. */
  limit?: number;
}

/** Compass directions in IOF sheet order; index + 1 = OCAD direction digit. */
const DIRECTIONS = 8;
/** Below this the control counts as *on* the feature, so no side-of. */
const SIDE_OF_MIN_MM = 0.3;

/** OCAD units per paper mm. */
const UNITS_PER_MM = 100;

type Pt = [number, number];

/** Squared distance from p to the segment a→b. */
function distSqToSegment(p: Pt, a: Pt, b: Pt): number {
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
  return (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
}

/** Ray-cast point-in-polygon over a closed or open ring. */
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

/** Shortest distance from p to the object, in OCAD units. */
function distanceToObject(p: Pt, obj: SlimMapObject): number {
  const coords = obj.coordinates;
  if (obj.objType === 1) {
    const [x, y] = coords[0];
    return Math.hypot(p[0] - x, p[1] - y);
  }
  if (obj.objType === 3 && coords.length > 2 && pointInRing(p, coords)) {
    return 0;
  }
  if (coords.length === 1) {
    return Math.hypot(p[0] - coords[0][0], p[1] - coords[0][1]);
  }
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distSqToSegment(p, coords[i], coords[i + 1]);
    if (d < best) best = d;
  }
  // Areas are rings: close them so the last edge counts too.
  if (obj.objType === 3 && coords.length > 2) {
    const d = distSqToSegment(p, coords[coords.length - 1], coords[0]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** The point a side-of direction is measured from. */
function referencePoint(p: Pt, obj: SlimMapObject): Pt {
  const coords = obj.coordinates;
  if (obj.objType === 1 || coords.length === 1) return coords[0];
  if (obj.objType === 3) {
    // Centroid of the ring vertices — good enough for a compact area
    // (buildings, ruins), and only such areas carry `g`.
    let sx = 0, sy = 0;
    for (const [x, y] of coords) {
      sx += x;
      sy += y;
    }
    return [sx / coords.length, sy / coords.length];
  }
  // Lines: the closest point on the polyline, so "N side of the bridge"
  // is relative to the part the control sits next to.
  let best = Infinity;
  let bestPt: Pt = coords[0];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const cand: Pt = [a[0] + t * dx, a[1] + t * dy];
    const d = (p[0] - cand[0]) ** 2 + (p[1] - cand[1]) ** 2;
    if (d < best) {
      best = d;
      bestPt = cand;
    }
  }
  return bestPt;
}

/**
 * Compass bearing (degrees clockwise from north) from `from` to `to`.
 * Paper Y points north, so north is +y — hence `atan2(dx, dy)`.
 */
export function compassBearing(from: Pt, to: Pt): number {
  const deg = (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Canonical OCAD column-G "side of" code for a bearing: N → "11.101",
 * NE → "11.102", … NW → "11.108" (see `control-description-options.ts`).
 */
export function sideOfCode(bearingDeg: number): string {
  const idx = Math.round(((bearingDeg % 360) + 360) % 360 / 45) % DIRECTIONS;
  return `11.${100 + idx + 1}`;
}

/**
 * Rank description candidates for a control at (xMm, yMm).
 *
 * Nearest feature first, one candidate per column-D code — several ISOM
 * symbols share one (footpath 505 and vehicle track 504 are both 5.002),
 * and the user picks a *description*, not a map symbol — capped at
 * `limit`.
 */
export function suggestDescriptions(
  objects: SlimMapObject[],
  xMm: number,
  yMm: number,
  opts: SuggestOptions = {},
): DescriptionCandidate[] {
  const radiusMm = opts.radiusMm ?? 3;
  const limit = opts.limit ?? 3;
  if (radiusMm <= 0 || limit <= 0) return [];

  const radius = radiusMm * UNITS_PER_MM;
  const p: Pt = [xMm * UNITS_PER_MM, yMm * UNITS_PER_MM];

  /** Nearest hit per column-D code. */
  const best = new Map<string, DescriptionCandidate>();

  for (const obj of objects) {
    const [minX, minY, maxX, maxY] = obj.bbox;
    if (
      p[0] < minX - radius || p[0] > maxX + radius ||
      p[1] < minY - radius || p[1] > maxY + radius
    ) {
      continue;
    }
    const entry = isomDescriptionFor(obj.sym);
    if (!entry) continue;

    const dist = distanceToObject(p, obj);
    if (dist > radius) continue;
    const distanceMm = dist / UNITS_PER_MM;

    const existing = best.get(entry.d);
    if (existing && existing.distanceMm <= distanceMm) continue;

    const candidate: DescriptionCandidate = {
      d: entry.d,
      isom: isomNumber(obj.sym),
      distanceMm,
    };
    if (entry.g && distanceMm >= SIDE_OF_MIN_MM) {
      candidate.g = sideOfCode(compassBearing(referencePoint(p, obj), p));
    }
    best.set(entry.d, candidate);
  }

  return [...best.values()]
    .sort((a, b) => a.distanceMm - b.distanceMm || a.isom - b.isom)
    .slice(0, limit);
}
