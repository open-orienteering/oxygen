/**
 * Control-description autodetect: rank the base-map features around a
 * point and propose IOF description columns D (feature), G (side of),
 * F (crossing / junction / bend), E (second feature), and C (which of
 * similar).
 *
 * Pure and unit-tested. The caller supplies the searchable objects from
 * `event-map-objects.ts` and a query point in paper mm; ISOM → column-D
 * translation comes from `ISOM_DESCRIPTION_MAP` in `@oxygen/shared`.
 */

import { isomDescriptionFor, isomNumber } from "@oxygen/shared";
import type { SlimMapObject } from "./event-map-objects.js";

export interface DescriptionCandidate {
  /** Canonical OCAD column-D code, e.g. "2.004" (boulder). */
  d: string;
  /** Canonical OCAD column-G code (side of / end), when a direction applies. */
  g?: string;
  /** Column C: which of similar (e.g. "0.201" = Northern). */
  c?: string;
  /** Column E: second feature of a crossing/junction (a column-D code). */
  e?: string;
  /** Column F: crossing / junction / bend. */
  f?: string;
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
/** Max distance to an intersection for crossing/junction proposals. */
const JUNCTION_RADIUS_MM = 1.5;
/**
 * How far a line's endpoint may sit from the line it "meets" and still
 * count as a junction. Mappers rarely snap exactly; 0.3 mm is well under
 * the width of a drawn path.
 */
const JUNCTION_SNAP_MM = 0.3;
/** Max distance to a sharp vertex for bend proposals. */
const BEND_RADIUS_MM = 0.7;
/** Min direction change (degrees) to count as a bend. */
const BEND_MIN_DEG = 45;
/** Max distance to a free polyline endpoint for "end" proposals. */
const END_RADIUS_MM = 0.5;
/** Neighbour search radius for which-of-similar (≈ control circle). */
const SIMILAR_RADIUS_MM = 3.0;
/** Inside an area but this close to its boundary → "edge of". */
const AREA_EDGE_MM = 1.0;
/** Min offset from the area centroid before edge / part get a direction. */
const AREA_EDGE_MIN_OFFSET_MM = 0.8;
/** Min offset from the centroid of a large area to call it a "part". */
const AREA_PART_MIN_OFFSET_MM = 2.0;
/** Max distance to a sharp boundary vertex for corner proposals. */
const CORNER_RADIUS_MM = 0.7;
/** Min direction change (degrees) at a boundary vertex to be a corner. */
const CORNER_MIN_DEG = 60;
/**
 * Ranking handicap for extended areas (open land, marsh, …). Being
 * *inside* one is not the same as being *at* it: a boulder half a
 * millimetre away is the better description than the clearing it
 * stands in, so areas rank by depth-from-edge plus this penalty.
 */
const AREA_RANK_PENALTY_MM = 0.5;

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

/** Closest point on segment a→b to p. */
function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  return [a[0] + t * dx, a[1] + t * dy];
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
  if (obj.objType === 3 && coords.length > 2) {
    const d = distSqToSegment(p, coords[coords.length - 1], coords[0]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Ring vertices without the closing duplicate / consecutive repeats. */
function ringVertices(coords: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const c of coords) {
    const last = out[out.length - 1];
    if (last && last[0] === c[0] && last[1] === c[1]) continue;
    out.push(c);
  }
  if (out.length > 1) {
    const [f, l] = [out[0], out[out.length - 1]];
    if (f[0] === l[0] && f[1] === l[1]) out.pop();
  }
  return out;
}

/** Area-weighted polygon centroid (falls back to the vertex mean). */
export function polygonCentroid(coords: Pt[]): Pt {
  const ring = ringVertices(coords);
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    area += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  if (Math.abs(area) < 1e-6) {
    let sx = 0, sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / Math.max(1, ring.length), sy / Math.max(1, ring.length)];
  }
  const f = 1 / (3 * area);
  return [cx * f, cy * f];
}

/** The point a side-of direction is measured from. */
function referencePoint(p: Pt, obj: SlimMapObject): Pt {
  const coords = obj.coordinates;
  if (obj.objType === 1 || coords.length === 1) return coords[0];
  if (obj.objType === 3) return polygonCentroid(coords);
  let best = Infinity;
  let bestPt: Pt = coords[0];
  for (let i = 0; i < coords.length - 1; i++) {
    const cand = closestOnSegment(p, coords[i], coords[i + 1]);
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

function directionIndex(bearingDeg: number): number {
  return Math.round(((bearingDeg % 360) + 360) % 360 / 45) % DIRECTIONS;
}

/**
 * Canonical OCAD column-G "side of" code for a bearing: N → "11.101",
 * NE → "11.102", … NW → "11.108".
 */
export function sideOfCode(bearingDeg: number): string {
  return `11.${100 + directionIndex(bearingDeg) + 1}`;
}

/** Column-G "edge of" (IOF 11.2): N → "11.201", … NW → "11.208". */
export function edgeOfCode(bearingDeg: number): string {
  return `11.${200 + directionIndex(bearingDeg) + 1}`;
}

/** Column-G "part of" (IOF 11.3): N → "11.301", … NW → "11.308". */
export function partOfCode(bearingDeg: number): string {
  return `11.${300 + directionIndex(bearingDeg) + 1}`;
}

/** Column-G "inside corner" (IOF 11.4): N → "11.401", … */
export function insideCornerCode(bearingDeg: number): string {
  return `11.${400 + directionIndex(bearingDeg) + 1}`;
}

/** Column-G "outside corner" (IOF 11.5): N → "11.501", … */
export function outsideCornerCode(bearingDeg: number): string {
  return `11.${500 + directionIndex(bearingDeg) + 1}`;
}

/** Column-G directional "end" codes: N → "11.701", … NW → "11.708". */
export function endOfCode(bearingDeg: number): string {
  return `11.${700 + directionIndex(bearingDeg) + 1}`;
}

/** Column-C which-of-similar codes: N → "0.201", … NW → "0.208". */
export function whichOfCode(bearingDeg: number): string {
  return `0.${200 + directionIndex(bearingDeg) + 1}`;
}

interface AreaInfo {
  inside: boolean;
  /** Distance from p to the ring boundary, mm (depth when inside). */
  boundaryMm: number;
  centroid: Pt;
  /** Sharp boundary vertex within CORNER_RADIUS_MM of p, if any. */
  corner: Pt | null;
}

/** Where p sits relative to an area's outline. */
function analyseArea(p: Pt, coords: Pt[]): AreaInfo {
  const ring = ringVertices(coords);
  const inside = ring.length > 2 && pointInRing(p, ring);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distSqToSegment(p, ring[j], ring[i]);
    if (d < best) best = d;
  }
  let corner: Pt | null = null;
  let cornerDist = CORNER_RADIUS_MM * UNITS_PER_MM;
  if (ring.length > 2) {
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i + ring.length - 1) % ring.length];
      const next = ring[(i + 1) % ring.length];
      const turn = 180 - angleBetween(prev, ring[i], next);
      if (turn < CORNER_MIN_DEG) continue;
      const d = Math.hypot(p[0] - ring[i][0], p[1] - ring[i][1]);
      if (d <= cornerDist) {
        cornerDist = d;
        corner = ring[i];
      }
    }
  }
  return {
    inside,
    boundaryMm: Math.sqrt(best) / UNITS_PER_MM,
    centroid: polygonCentroid(ring),
    corner,
  };
}

/**
 * Column-G location for a control at / in an extended area (marsh, open
 * land, …): corner when at a sharp boundary vertex, edge when just inside
 * or just outside the outline, part when well inside a large area.
 */
function areaLocation(p: Pt, info: AreaInfo): string | undefined {
  const { centroid } = info;
  if (info.corner) {
    const bearing = compassBearing(centroid, info.corner);
    return info.inside ? insideCornerCode(bearing) : outsideCornerCode(bearing);
  }
  const offsetMm = Math.hypot(p[0] - centroid[0], p[1] - centroid[1]) / UNITS_PER_MM;
  if (offsetMm < AREA_EDGE_MIN_OFFSET_MM) return undefined;
  const bearing = compassBearing(centroid, p);
  if (!info.inside) return edgeOfCode(bearing);
  if (info.boundaryMm <= AREA_EDGE_MM) return edgeOfCode(bearing);
  if (offsetMm >= AREA_PART_MIN_OFFSET_MM) return partOfCode(bearing);
  return undefined;
}

/** Segment–segment intersection; null if parallel / non-overlapping. */
function segmentIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const dx1 = b[0] - a[0];
  const dy1 = b[1] - a[1];
  const dx2 = d[0] - c[0];
  const dy2 = d[1] - c[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c[0] - a[0]) * dy2 - (c[1] - a[1]) * dx2) / denom;
  const u = ((c[0] - a[0]) * dy1 - (c[1] - a[1]) * dx1) / denom;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return [a[0] + t * dx1, a[1] + t * dy1];
}

function angleBetween(a: Pt, b: Pt, c: Pt): number {
  const abx = a[0] - b[0];
  const aby = a[1] - b[1];
  const cbx = c[0] - b[0];
  const cby = c[1] - b[1];
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, dot / mag));
  return (Math.acos(cos) * 180) / Math.PI;
}

function pointNear(a: Pt, b: Pt, tol: number): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
}

interface LineHit {
  obj: SlimMapObject;
  d: string;
  isom: number;
}

/**
 * Crossing / junction between two line features near the query point.
 * Crossing = both lines continue past the intersection; junction = an
 * endpoint of one lies on the other.
 */
function findJunctionOrCrossing(
  lines: LineHit[],
  p: Pt,
  radiusUnits: number,
): DescriptionCandidate | null {
  let best: DescriptionCandidate | null = null;
  const endpointTol = JUNCTION_SNAP_MM * UNITS_PER_MM;

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      const ac = a.obj.coordinates;
      const bc = b.obj.coordinates;
      if (ac.length < 2 || bc.length < 2) continue;

      // Segment intersections. Near an endpoint of either line → junction;
      // both continue past the hit → crossing.
      for (let ai = 0; ai < ac.length - 1; ai++) {
        for (let bi = 0; bi < bc.length - 1; bi++) {
          const hit = segmentIntersection(ac[ai], ac[ai + 1], bc[bi], bc[bi + 1]);
          if (!hit) continue;
          const dist = Math.hypot(p[0] - hit[0], p[1] - hit[1]);
          if (dist > radiusUnits) continue;
          const distanceMm = dist / UNITS_PER_MM;
          const nearEndA =
            pointNear(hit, ac[0], endpointTol) ||
            pointNear(hit, ac[ac.length - 1], endpointTol);
          const nearEndB =
            pointNear(hit, bc[0], endpointTol) ||
            pointNear(hit, bc[bc.length - 1], endpointTol);
          const f = nearEndA || nearEndB ? "10.002" : "10.001";
          const cand = makePairCandidate(a, b, f, distanceMm, p);
          if (!best || cand.distanceMm < best.distanceMm) best = cand;
        }
      }

      // Endpoint of one on the other → junction.
      for (const [endObj, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const ends = [
          endObj.obj.coordinates[0],
          endObj.obj.coordinates[endObj.obj.coordinates.length - 1],
        ];
        for (const end of ends) {
          const distToOther = distanceToObject(end, other.obj);
          if (distToOther > endpointTol) continue;
          const dist = Math.hypot(p[0] - end[0], p[1] - end[1]);
          if (dist > radiusUnits) continue;
          const distanceMm = dist / UNITS_PER_MM;
          const cand = makePairCandidate(endObj, other, "10.002", distanceMm, p);
          if (!best || cand.distanceMm < best.distanceMm) best = cand;
        }
      }
    }
  }
  return best;
}

function makePairCandidate(
  a: LineHit,
  b: LineHit,
  f: string,
  distanceMm: number,
  p: Pt,
): DescriptionCandidate {
  // IOF sheet convention for a crossing / junction: column D is the
  // first feature, column E the second, F the combination — *also* when
  // both are the same kind ("path junction" = path · path · junction).
  // The line the control is nearer to becomes column D.
  const [near, far] =
    distanceToObject(p, a.obj) <= distanceToObject(p, b.obj) ? [a, b] : [b, a];
  return {
    d: near.d,
    e: far.d,
    f,
    isom: near.isom,
    distanceMm,
  };
}

/** Sharp bend on a single polyline near the query point. */
function findBend(
  lines: LineHit[],
  p: Pt,
  radiusUnits: number,
): DescriptionCandidate | null {
  let best: DescriptionCandidate | null = null;
  for (const line of lines) {
    const coords = line.obj.coordinates;
    for (let i = 1; i < coords.length - 1; i++) {
      const turn = 180 - angleBetween(coords[i - 1], coords[i], coords[i + 1]);
      if (turn < BEND_MIN_DEG) continue;
      const dist = Math.hypot(p[0] - coords[i][0], p[1] - coords[i][1]);
      if (dist > radiusUnits) continue;
      const distanceMm = dist / UNITS_PER_MM;
      if (!best || distanceMm < best.distanceMm) {
        best = { d: line.d, f: "11.001", isom: line.isom, distanceMm };
      }
    }
  }
  return best;
}

/**
 * Free polyline endpoint near the control → directional "end" in G.
 * An endpoint is free when no other line of the same D ends within
 * 0.3 mm of it (so a T-junction isn't reported as an end).
 */
function findEnd(
  lines: LineHit[],
  p: Pt,
  radiusUnits: number,
): DescriptionCandidate | null {
  let best: DescriptionCandidate | null = null;
  const shareTol = 30; // 0.3 mm

  for (const line of lines) {
    const coords = line.obj.coordinates;
    if (coords.length < 2) continue;
    const ends: Array<{ pt: Pt; inward: Pt }> = [
      { pt: coords[0], inward: coords[1] },
      { pt: coords[coords.length - 1], inward: coords[coords.length - 2] },
    ];
    for (const { pt, inward } of ends) {
      // An endpoint that lies on another line is a junction, not an end.
      const onOther = lines.some(
        (other) =>
          other !== line &&
          distanceToObject(pt, other.obj) <= shareTol,
      );
      if (onOther) continue;
      const shared = lines.some(
        (other) =>
          other !== line &&
          other.d === line.d &&
          (pointNear(pt, other.obj.coordinates[0], shareTol) ||
            pointNear(
              pt,
              other.obj.coordinates[other.obj.coordinates.length - 1],
              shareTol,
            )),
      );
      if (shared) continue;
      const dist = Math.hypot(p[0] - pt[0], p[1] - pt[1]);
      if (dist > radiusUnits) continue;
      const distanceMm = dist / UNITS_PER_MM;
      // Bearing from the feature towards the endpoint (= along the line).
      const bearing = compassBearing(inward, pt);
      if (!best || distanceMm < best.distanceMm) {
        best = {
          d: line.d,
          g: endOfCode(bearing),
          isom: line.isom,
          distanceMm,
        };
      }
    }
  }
  return best;
}

/**
 * Rank description candidates for a control at (xMm, yMm).
 *
 * Nearest feature first, one candidate per column-D code — several ISOM
 * symbols share one (footpath 505 and vehicle track 504 are both 5.002),
 * and the user picks a *description*, not a map symbol — capped at
 * `limit`. Junction / crossing / bend / end / which-of-similar enrich
 * the nearest hits when the geometry supports it.
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
  /**
   * Ranking distance per candidate. Equals `distanceMm` except for
   * extended areas, which rank by depth-from-edge + penalty so a point
   * feature beside the control beats the clearing it stands in.
   */
  const ranks = new WeakMap<DescriptionCandidate, number>();
  const rankOf = (c: DescriptionCandidate) => ranks.get(c) ?? c.distanceMm;
  const nearbyLines: LineHit[] = [];
  /** All nearby point/compact-area hits (for which-of-similar). */
  const nearbyPoints: Array<{
    d: string;
    isom: number;
    ref: Pt;
    distanceMm: number;
    g?: boolean;
  }> = [];

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
    const isom = isomNumber(obj.sym);

    if (obj.objType === 2 && obj.coordinates.length >= 2) {
      nearbyLines.push({ obj, d: entry.d, isom });
    }
    if (obj.objType === 1 || (obj.objType === 3 && entry.g)) {
      nearbyPoints.push({
        d: entry.d,
        isom,
        ref: referencePoint(p, obj),
        distanceMm,
        g: entry.g,
      });
    }

    const candidate: DescriptionCandidate = {
      d: entry.d,
      isom,
      distanceMm,
    };
    let rank = distanceMm;
    const isArea = obj.objType === 3 && obj.coordinates.length > 2;
    if (isArea) {
      const info = analyseArea(p, obj.coordinates);
      if (entry.g) {
        // Compact area (building, ruin, rock pillar): side-of from the
        // centroid, or the outside corner when the control sits at one.
        if (!info.inside && distanceMm >= SIDE_OF_MIN_MM) {
          candidate.g = info.corner
            ? outsideCornerCode(compassBearing(info.centroid, info.corner))
            : sideOfCode(compassBearing(info.centroid, p));
        }
      } else {
        rank = info.boundaryMm + AREA_RANK_PENALTY_MM;
        const g = areaLocation(p, info);
        if (g) candidate.g = g;
      }
    } else if (entry.g && distanceMm >= SIDE_OF_MIN_MM) {
      candidate.g = sideOfCode(compassBearing(referencePoint(p, obj), p));
    }

    const existing = best.get(entry.d);
    if (existing && rankOf(existing) <= rank) continue;
    ranks.set(candidate, rank);
    best.set(entry.d, candidate);
  }

  // Enrich / override with junction, crossing, bend, end — these beat
  // plain line hits when the control sits on the intersection.
  const junction = findJunctionOrCrossing(
    nearbyLines,
    p,
    JUNCTION_RADIUS_MM * UNITS_PER_MM,
  );
  if (junction) {
    // Within JUNCTION_RADIUS_MM the junction is the better description
    // of the same line than "the path" alone — even when the control is
    // nearer to the line than to the exact intersection point (nobody
    // places a circle centre with 0.1 mm precision). Other features
    // still compete on the junction's own distance.
    best.set(junction.d, junction);
    // Drop the second feature's plain candidate so we don't list it twice
    // (for a same-kind junction the second feature *is* the candidate).
    if (junction.e && junction.e !== junction.d) best.delete(junction.e);
  }

  const bend = findBend(nearbyLines, p, BEND_RADIUS_MM * UNITS_PER_MM);
  if (bend) {
    const existing = best.get(bend.d);
    if (!existing || bend.distanceMm < existing.distanceMm || !existing.f) {
      best.set(bend.d, {
        ...bend,
        // Preserve a side-of if the bend candidate has none and the
        // existing one does (rare for lines).
        g: bend.g ?? existing?.g,
      });
    }
  }

  const end = findEnd(nearbyLines, p, END_RADIUS_MM * UNITS_PER_MM);
  if (end) {
    const existing = best.get(end.d);
    // Same reasoning as for junctions: beside the tip of a line the
    // "end" is the description, unless a combination (junction / bend)
    // already claimed the feature.
    if (!existing || !existing.f) {
      best.set(end.d, {
        ...(existing ?? end),
        ...end,
        // End wins over a plain side-of for the same feature.
        g: end.g,
      });
    }
  }

  // Which of similar: for each nearest point feature, if another of the
  // same D exists within the control circle, set column C from the
  // bearing of the chosen feature relative to the others' centroid.
  for (const [d, cand] of best) {
    if (cand.f || cand.c) continue;
    const peers = nearbyPoints.filter(
      (pt) => pt.d === d && pt.distanceMm <= SIMILAR_RADIUS_MM,
    );
    if (peers.length < 2) continue;
    // Chosen = nearest peer (matches cand).
    peers.sort((a, b) => a.distanceMm - b.distanceMm);
    const chosen = peers[0];
    const others = peers.slice(1);
    let sx = 0, sy = 0;
    for (const o of others) {
      sx += o.ref[0];
      sy += o.ref[1];
    }
    const centroid: Pt = [sx / others.length, sy / others.length];
    // Only set C when the chosen feature is meaningfully offset.
    if (Math.hypot(chosen.ref[0] - centroid[0], chosen.ref[1] - centroid[1]) < 20) {
      continue;
    }
    cand.c = whichOfCode(compassBearing(centroid, chosen.ref));
  }

  // Prefer geometric combinations (crossing / junction / bend) over plain
  // or end hits at the same spot: drop rivals that share a D/E with a
  // combination candidate.
  for (const cand of [...best.values()]) {
    if (!cand.f) continue;
    for (const [d, other] of [...best.entries()]) {
      if (other === cand) continue;
      if (other.d === cand.e || (other.e && other.e === cand.d)) {
        best.delete(d);
      }
    }
  }

  return [...best.values()]
    .sort((a, b) => rankOf(a) - rankOf(b) || a.isom - b.isom)
    .slice(0, limit);
}
