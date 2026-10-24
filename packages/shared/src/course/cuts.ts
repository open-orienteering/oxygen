/**
 * Automatic overprint cuts (docs/course-layer.md §3.4): the course is cut
 * where it would hide a compact knoll or rock point feature. A cut clears
 * the feature's own symbol plus half the drawn line plus `CUT_AIR_MM` of
 * visible air, so the overprint's line ends — round caps included — stay
 * that far from the symbol on paper at any print scale. The features come
 * from the map document (vector events) or the legacy OCAD parse (C5).
 *
 * Paper mm, y-up. Circle gaps are compass degrees (0° = +y, clockwise),
 * leg gaps fractions of the leg.
 */

import type { AngularGap, FractionGap } from "../course-maps/overlay-geometry.js";
import { OBJECT_TYPE } from "../map-document/header.js";
import type { MapDocument } from "../map-document/codec.js";
import { isAppliedMatch } from "../map-document/render-bridge.js";
import { getLibraryEntry, getSymbolLibrary, type SymbolLibraryId } from "../symbol-library/index.js";
import type { LibraryEntry } from "../symbol-library/schema.js";
import { courseDocumentContext } from "./context.js";
import type { CutFeature } from "./types.js";

/** Compact ISOM point symbols that receive automatic cuts: knoll, elongated knoll, rocky pit, boulder, large boulder, boulder cluster. */
export const CUT_CODES: ReadonlySet<number> = new Set([109, 110, 203, 204, 205, 207]);

/** Visible air between a cut feature's symbol and the overprint line, paper mm (user, 2026-10-24). */
export const CUT_AIR_MM = 0.25;
/** Symbol radius of a feature that carries none: an ISOM knoll at 1:15 000, mm. */
export const DEFAULT_FEATURE_RADIUS_MM = 0.25;
/** The legacy control circle and line the stored GeoJSON is drawn with, mm. */
const LEGACY_RADIUS_MM = 2.5;
const LEGACY_LINE_MM = 0.35;
const MIN_SLIT_DEG = 4;
const MAX_TOTAL_SLIT_DEG = 300;
/** Legs keep 1.2 × the circle radius at each end (the circle clipping takes that anyway). */
const LEG_END_KEEP = 1.2;
/** Leg gaps shorter than this are dropped, mm. */
const MIN_LEG_GAP_MM = 0.6;
const MAX_TOTAL_LEG_GAP = 0.7;

type Pt = [number, number];

/** How far the line's centre must stay from a feature's centre: its symbol + half the line + the air. */
const clearanceOf = (f: CutFeature, lineWidthMm: number) => (f.r ?? DEFAULT_FEATURE_RADIUS_MM) + lineWidthMm / 2 + CUT_AIR_MM;

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
 * Slits for a control circle of centre-line radius `radiusMm` drawn
 * `lineWidthMm` wide: every feature whose clearance reaches the rim opens
 * the arc between the two rim points at exactly that clearance.
 */
export function circleCuts(features: readonly CutFeature[], x: number, y: number, radiusMm = LEGACY_RADIUS_MM, lineWidthMm = LEGACY_LINE_MM): AngularGap[] {
  const R = radiusMm;
  const gaps: { start: number; end: number }[] = [];
  for (const f of features) {
    const c = clearanceOf(f, lineWidthMm);
    if (Math.abs(f.x - x) > R + c || Math.abs(f.y - y) > R + c) continue;
    const d = Math.hypot(f.x - x, f.y - y);
    if (d === 0 || Math.abs(d - R) >= c) continue;
    const cos = (R * R + d * d - c * c) / (2 * R * d);
    if (cos <= -1) return [];
    const halfDeg = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
    const start = (((compassBearing([x, y], [f.x, f.y]) - halfDeg) % 360) + 360) % 360;
    gaps.push({ start, end: start + 2 * halfDeg });
  }
  return mergeArcGaps(gaps);
}

/** Gaps for the straight leg a → b, opened between the two points of the line at each feature's clearance. */
export function legGaps(a: Pick<CutFeature, "x" | "y">, b: Pick<CutFeature, "x" | "y">, features: readonly CutFeature[], radiusMm = LEGACY_RADIUS_MM, lineWidthMm = LEGACY_LINE_MM): FractionGap[] {
  const endKeep = LEG_END_KEEP * radiusMm;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 2 * endKeep + MIN_LEG_GAP_MM) return [];
  const raw: Array<[number, number]> = [];
  for (const f of features) {
    const c = clearanceOf(f, lineWidthMm);
    const t = ((f.x - a.x) * dx + (f.y - a.y) * dy) / (len * len);
    if (t < -c / len || t > 1 + c / len) continue;
    const off = Math.abs((f.x - a.x) * dy - (f.y - a.y) * dx) / len;
    if (off >= c) continue;
    const half = Math.sqrt(c * c - off * off) / len;
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
  let kept = merged.filter(([lo, hi]) => (hi - lo) * len >= MIN_LEG_GAP_MM);
  const total = () => kept.reduce((sum, [lo, hi]) => sum + (hi - lo), 0);
  while (kept.length > 0 && total() > MAX_TOTAL_LEG_GAP) {
    let smallest = 0;
    for (let i = 1; i < kept.length; i++) if (kept[i][1] - kept[i][0] < kept[smallest][1] - kept[smallest][0]) smallest = i;
    kept = kept.filter((_, i) => i !== smallest);
  }
  return kept.map(([from, to]) => ({ from, to }));
}

/** Farthest ink of a library point entry from its origin, mm (0 for other kinds). */
function entryRadiusMm(entry: LibraryEntry | undefined): number {
  if (!entry || entry.render.type !== "point") return 0;
  let r = 0;
  for (const p of entry.render.glyph.parts) {
    const off = Math.hypot(p.cx ?? 0, p.cy ?? 0);
    if (p.diameterUm !== undefined) r = Math.max(r, off + p.diameterUm / 2);
    const coords = p.geometry?.coords ?? [];
    const half = p.kind === "stroke" ? (p.widthUm ?? 0) / 2 : 0;
    for (let i = 0; i + 1 < coords.length; i += 2) r = Math.max(r, Math.hypot(coords[i], coords[i + 1]) + half);
  }
  return r / 1000;
}

const codeNumber = (code: string): number => parseInt(code, 10);

/**
 * Symbol radius at the library's reference scale of a cut code, mm: the
 * entry with exactly this code, else the heading's drawing (the first
 * entry of the integer code — `203` → ISOM `203.1` rocky pit).
 */
export function cutSymbolRadiusMm(libraryId: SymbolLibraryId, code: string): number {
  const entries = getSymbolLibrary(libraryId).entries;
  const exact = entries.find((e) => e.code === code);
  const n = codeNumber(code);
  return entryRadiusMm(exact ?? entries.find((e) => codeNumber(e.code) === n));
}

/** Library and document factor of a map known only by its scale (legacy OCAD events; 03 §6.5). */
export function cutContextForScale(mapScale: number): { libraryId: SymbolLibraryId; documentFactor: number } {
  const { libraryId, documentFactor } = courseDocumentContext({ library: null, documentFactor: 1, mapScale, colours: [] });
  return { libraryId, documentFactor };
}

/**
 * The cut features of a map document: point objects of visible symbols
 * whose applied match — or, unmatched, whose source code — is in
 * `CUT_CODES`, each with its symbol radius (the matched entry's, else the
 * code's in the document's library) × the document factor. Paper mm.
 */
export function cutFeaturesOfDocument(doc: MapDocument): CutFeature[] {
  const ctx = courseDocumentContext(doc.header);
  const radii = doc.header.symbols.map((s): number | null => {
    if (s.hidden) return null;
    if (isAppliedMatch(s.match)) {
      const code = s.match.canonicalId.slice(s.match.canonicalId.indexOf(":") + 1);
      return CUT_CODES.has(codeNumber(code)) ? entryRadiusMm(getLibraryEntry(s.match.canonicalId)) * ctx.documentFactor : null;
    }
    return CUT_CODES.has(codeNumber(s.code)) ? cutSymbolRadiusMm(ctx.libraryId, s.code) * ctx.documentFactor : null;
  });
  const perMm = doc.header.unitsPerMm;
  const out: CutFeature[] = [];
  for (let i = 0; i < doc.header.objects.count; i++) {
    const r = radii[doc.attrs.symbolIdx[i]];
    if (doc.attrs.type[i] !== OBJECT_TYPE.point || r === null) continue;
    const k = doc.coordStart[i] * 2;
    out.push({ x: doc.coords[k] / perMm, y: doc.coords[k + 1] / perMm, r });
  }
  return out;
}
