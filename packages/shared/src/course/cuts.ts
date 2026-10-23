/**
 * Automatic overprint cuts (docs/course-layer.md §3.4): the course is cut
 * where it would hide a compact knoll or rock point feature. The rule and
 * its numbers are `packages/api/src/overprint-cuts.ts`'s (docs/course-editor.md
 * "Automatic overprint cuts"), over a feature list instead of parsed OCAD
 * objects, so the features can come from the map document (vector
 * events) or from the legacy OCAD parse (C5).
 *
 * Paper mm, y-up. Circle gaps are compass degrees (0° = +y, clockwise),
 * leg gaps fractions of the leg.
 */

import type { AngularGap, FractionGap } from "../course-maps/overlay-geometry.js";
import { OBJECT_TYPE } from "../map-document/header.js";
import type { MapDocument } from "../map-document/codec.js";
import { isAppliedMatch } from "../map-document/render-bridge.js";
import type { CutFeature } from "./types.js";

/** Compact ISOM point symbols that receive automatic cuts: knoll, elongated knoll, rocky pit, boulder, large boulder, boulder cluster. */
export const CUT_CODES: ReadonlySet<number> = new Set([109, 110, 203, 204, 205, 207]);

/** The legacy circle radius the constants below were tuned at, mm. */
const REFERENCE_RADIUS_MM = 2.5;
/** A feature within this of the rim / leg centreline gets a cut (× scale). */
const POINT_REACH_MM = 0.45;
/** Half-width of the cut around a feature (× scale). */
const POINT_CUT_HALF_MM = 0.4;
const MIN_SLIT_DEG = 4;
const MAX_TOTAL_SLIT_DEG = 300;
/** Legs keep 1.2 × the circle radius at each end (the circle clipping takes that anyway). */
const LEG_END_KEEP = 1.2;
/** Leg gaps shorter than this are dropped (× scale). */
const MIN_LEG_GAP_MM = 0.6;
const MAX_TOTAL_LEG_GAP = 0.7;

type Pt = [number, number];

function compassBearing(from: Pt, to: Pt): number {
  return ((Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI + 360) % 360;
}

function mergeArcGaps(gaps: { start: number; end: number }[]): AngularGap[] {
  const linear: Array<[number, number]> = [];
  for (const g of gaps) {
    if (g.end - g.start >= 360) return [];
    if (g.end > 360) linear.push([g.start, 360], [0, g.end - 360]);
    else linear.push([g.start, g.end]);
  }
  linear.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const g of linear) {
    const last = merged[merged.length - 1];
    if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]);
    else merged.push([g[0], g[1]]);
  }
  if (merged.length > 1 && merged[0][0] === 0 && merged[merged.length - 1][1] === 360) {
    const tail = merged.pop()!;
    merged[0] = [tail[0], 360 + merged[0][1]];
  }
  const kept = merged.filter(([s, e]) => e - s >= MIN_SLIT_DEG);
  if (kept.reduce((sum, [s, e]) => sum + (e - s), 0) > MAX_TOTAL_SLIT_DEG) return [];
  return kept.map(([s, e]) => ({ start: s % 360, end: e % 360 }));
}

/**
 * Slits for a control circle of centre-line radius `radiusMm`: features on
 * the rim. `scale` multiplies the reach and cut widths (the document
 * factor: features and strokes grow with it).
 */
export function circleCuts(features: readonly CutFeature[], x: number, y: number, radiusMm = REFERENCE_RADIUS_MM, scale = 1): AngularGap[] {
  const reach = POINT_REACH_MM * scale;
  const halfDeg = (Math.asin(Math.min(0.95, (POINT_CUT_HALF_MM * scale) / radiusMm)) * 180) / Math.PI;
  const gaps: { start: number; end: number }[] = [];
  for (const f of features) {
    if (Math.abs(f.x - x) > radiusMm + reach || Math.abs(f.y - y) > radiusMm + reach) continue;
    const d = Math.hypot(f.x - x, f.y - y);
    if (Math.abs(d - radiusMm) > reach) continue;
    const start = (((compassBearing([x, y], [f.x, f.y]) - halfDeg) % 360) + 360) % 360;
    gaps.push({ start, end: start + 2 * halfDeg });
  }
  return mergeArcGaps(gaps);
}

/** Gaps for the straight leg a → b where it passes over a feature. */
export function legGaps(a: CutFeature, b: CutFeature, features: readonly CutFeature[], radiusMm = REFERENCE_RADIUS_MM, scale = 1): FractionGap[] {
  const reach = POINT_REACH_MM * scale;
  const minGap = MIN_LEG_GAP_MM * scale;
  const endKeep = LEG_END_KEEP * radiusMm;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 2 * endKeep + minGap) return [];
  const raw: Array<[number, number]> = [];
  for (const f of features) {
    const t = Math.max(0, Math.min(1, ((f.x - a.x) * dx + (f.y - a.y) * dy) / (len * len)));
    if (Math.hypot(f.x - (a.x + t * dx), f.y - (a.y + t * dy)) > reach) continue;
    const half = (POINT_CUT_HALF_MM * scale) / len;
    raw.push([t - half, t + half]);
  }
  if (raw.length === 0) return [];
  const endT = endKeep / len;
  const clamped = raw.map(([lo, hi]): [number, number] => [Math.max(lo, endT), Math.min(hi, 1 - endT)]).filter(([lo, hi]) => hi > lo);
  clamped.sort((p, q) => p[0] - q[0]);
  const merged: Array<[number, number]> = [];
  for (const g of clamped) {
    const last = merged[merged.length - 1];
    if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]);
    else merged.push([g[0], g[1]]);
  }
  let kept = merged.filter(([lo, hi]) => (hi - lo) * len >= minGap);
  const total = () => kept.reduce((sum, [lo, hi]) => sum + (hi - lo), 0);
  while (kept.length > 0 && total() > MAX_TOTAL_LEG_GAP) {
    let smallest = 0;
    for (let i = 1; i < kept.length; i++) if (kept[i][1] - kept[i][0] < kept[smallest][1] - kept[smallest][0]) smallest = i;
    kept = kept.filter((_, i) => i !== smallest);
  }
  return kept.map(([from, to]) => ({ from, to }));
}

const codeNumber = (code: string): number => parseInt(code, 10);

/**
 * The cut features of a map document: point objects of visible symbols
 * whose applied match — or, unmatched, whose source code — is in
 * `CUT_CODES`. Paper mm.
 */
export function cutFeaturesOfDocument(doc: MapDocument): CutFeature[] {
  const cuts = doc.header.symbols.map((s) => {
    if (s.hidden) return false;
    if (isAppliedMatch(s.match)) {
      const code = s.match.canonicalId.slice(s.match.canonicalId.indexOf(":") + 1);
      return CUT_CODES.has(codeNumber(code));
    }
    return CUT_CODES.has(codeNumber(s.code));
  });
  const perMm = doc.header.unitsPerMm;
  const out: CutFeature[] = [];
  for (let i = 0; i < doc.header.objects.count; i++) {
    if (doc.attrs.type[i] !== OBJECT_TYPE.point || !cuts[doc.attrs.symbolIdx[i]]) continue;
    const k = doc.coordStart[i] * 2;
    out.push({ x: doc.coords[k] / perMm, y: doc.coords[k + 1] / perMm });
  }
  return out;
}
