/**
 * A converted track's ends snapped to the track network (docs/map-gps-tracks.md §6.7; docs/course-editor.md §13 "GPS
 * tracks: junctions"; row G28): which symbols are track lines, and the end snap itself. Pure; no React.
 *
 * Each end of the new line within 1.5 mm on paper of a track line is moved onto it, in this order:
 * 1. **End to end**: onto the nearest track line's end node, when one is within 1.5 mm — the two share a vertex
 *    (joining them is G10's *Join*).
 * 2. **Overshoot**: else, when the line crosses that track line and every node after the crossing lies within 1.5 mm
 *    of it, the line is cut at the crossing (the crossing nearest the end).
 * 3. **Short**: else the end node is moved to the nearest point on the track line (the last segment extended
 *    straight onto it).
 * The other line is never changed. Only straight end segments are snapped (a converted track is a polyline).
 */

import { mapDocument, render, symbolLibrary } from "@oxygen/shared";
import type { LineHit } from "../../../../../lib/editor/snap";

type C = mapDocument.PatchCoord;
type Pt = { x: number; y: number };

/** The reach of the end snap, paper mm (SLICES G28; its own, not the 0.5 mm of 08 §5.3). */
export const SNAP_ENDS_MM = 1.5;

/** The ISSkiOM track group's line entries (map-gps-tracks §6 answer 4; `map-symbols.md` §12.1): 808 is an area. */
export const TRACK_ENTRY_IDS: ReadonlySet<string> = new Set(
  ["801.1", "801.2", "802.1", "802.2", "803.1", "803.2", "804.1", "804.2", "805", "807", "813.1", "813.2"].map((c) => `ISSkiOM2019:${c}`),
);

/** A document symbol's source code in the 800s (`801.0`, `813`): a track line when it has no applied match. */
const isTrackCode = (code: string): boolean => /^8\d\d(\.\d+)?$/.test(code);

/** Whether a symbol of the combined table is a track line (§6 answer 4). Patch symbols are keyed by their entry id. */
function isTrackSymbol(doc: Pick<mapDocument.EffectiveDocument, "header" | "patch">, idx: number): boolean {
  const s = doc.header.symbols[idx];
  if (!s || s.kind !== "line") return false;
  const base = doc.patch?.baseSymbols ?? doc.header.symbols.length;
  if (idx >= base) return TRACK_ENTRY_IDS.has(doc.patch?.symbols[idx - base] ?? "");
  return mapDocument.isAppliedMatch(s.match) ? TRACK_ENTRY_IDS.has(s.match.canonicalId) : isTrackCode(s.code);
}

/**
 * The track-symbol filter of a document (its combined symbol table), as `nearestOnLines` takes it: the ISSkiOM track
 * group, as a document symbol matched to one of its entries or a patch symbol of one; a document line symbol with no
 * applied match whose code is in the 800s. Roads and paths (ISOM 501–508) and everything else are out.
 */
export function trackSymbolFilter(doc: Pick<mapDocument.EffectiveDocument, "header" | "patch">): (symbolIdx: number) => boolean {
  const table = doc.header.symbols.map((_, i) => isTrackSymbol(doc, i));
  return (i) => table[i] ?? false;
}

/** Whether a patch symbol reference is a track line: a document symbol by the filter, a patch symbol by its key. */
export function isTrackSymbolRef(doc: Pick<mapDocument.EffectiveDocument, "header" | "patch">, ref: mapDocument.PatchSymbolRef): boolean {
  if ("patch" in ref) return TRACK_ENTRY_IDS.has(ref.patch);
  const base = doc.patch?.baseSymbols ?? doc.header.symbols.length;
  return ref.doc < base && isTrackSymbol(doc, ref.doc);
}

/** The library's track-group line entries, for the test that ties `TRACK_ENTRY_IDS` to the library. */
export function libraryTrackLineIds(): string[] {
  return symbolLibrary.getSymbolLibrary("ISSkiOM2019").entries
    .filter((e) => e.scaleGroup === "track" && e.render.type === "line")
    .map((e) => e.id);
}

// ─── The snap ──

const F = render.COORD_FLAG;
const CURVE = F.bezierFirst | F.bezierSecond;
const SIDES = F.noLeft | F.noRight;
const EPS = 1e-9;
/** An end this close to its target (document units: half a unit's diagonal) is on it — a snapped end, rounded. */
const ON_LINE_UNITS = Math.SQRT1_2 + 1e-6;
const flagsOf = (c: C): number => c[2] ?? 0;
const at = (x: number, y: number, f: number): C => (f ? [x, y, f] : [x, y]);
const isAnchor = (c: C): boolean => (flagsOf(c) & CURVE) === 0;
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The nearest track line to a point (paper mm) within `SNAP_ENDS_MM`, or null. */
export type FindLine = (pt: Pt) => LineHit | null;

/** How an end was snapped. */
export type EndSnap = "end" | "cut" | "moved" | null;

/** The crossing of segment a→b with polyline `path` nearest b (largest t on a→b), or null. */
function crossingNearB(a: Pt, b: Pt, path: readonly Pt[]): Pt | null {
  let best: Pt | null = null, bestT = -1;
  const rx = b.x - a.x, ry = b.y - a.y;
  for (let k = 0; k + 1 < path.length; k++) {
    const c = path[k], d = path[k + 1];
    const sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < EPS) continue;
    const qx = c.x - a.x, qy = c.y - a.y;
    const t = (qx * sy - qy * sx) / den;
    const u = (qx * ry - qy * rx) / den;
    if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) continue;
    if (t > bestT) { bestT = t; best = { x: a.x + t * rx, y: a.y + t * ry }; }
  }
  return best;
}

/** The distance from `pt` to polyline `path`. */
function distanceTo(path: readonly Pt[], pt: Pt): number {
  let best = Infinity;
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx - pt.x, a.y + t * dy - pt.y));
  }
  return best;
}

/** Consecutive coordinates on the same unit merged: the earlier kept, except that the last is the (new) end. */
function dedupe(coords: readonly C[]): C[] {
  const out: C[] = [];
  coords.forEach((c, k) => {
    const prev = out[out.length - 1];
    if (prev && prev[0] === c[0] && prev[1] === c[1]) {
      if (k === coords.length - 1) out[out.length - 1] = c;
      return;
    }
    out.push(c);
  });
  return out;
}

const sameCoords = (a: readonly C[], b: readonly C[]): boolean =>
  a.length === b.length && a.every((c, k) => c[0] === b[k][0] && c[1] === b[k][1] && flagsOf(c) === flagsOf(b[k]));
const distinct = (coords: readonly C[]): number => new Set(coords.map((c) => `${c[0]},${c[1]}`)).size;

/**
 * The line's last end snapped (`coords` in document units, the end at the array's end): the rules of the module
 * comment, the result rounded to whole units. Unchanged (and `how` null) when nothing is in reach, the end segment is
 * a curve, or the result would have fewer than two distinct coordinates.
 */
function snapLastEnd(coords: readonly C[], find: FindLine, u: number): { coords: C[]; how: EndSnap } {
  const same: { coords: C[]; how: EndSnap } = { coords: [...coords], how: null };
  const n = coords.length;
  if (n < 2 || !isAnchor(coords[n - 1]) || !isAnchor(coords[n - 2])) return same;
  const mm = (c: C): Pt => ({ x: c[0] / u, y: c[1] / u });
  const end = mm(coords[n - 1]);
  const hit = find(end);
  if (!hit) return same;
  const round = (p: Pt, f: number): C => at(Math.round(p.x * u), Math.round(p.y * u), f);
  const endFlags = flagsOf(coords[n - 1]) & ~SIDES;
  /** A candidate result, or null when it breaks the line (under two distinct coordinates) or changes nothing. */
  const result = (out: C[], how: EndSnap) => {
    const d = dedupe(out);
    return distinct(d) >= 2 && !sameCoords(d, coords) ? { coords: d, how } : null;
  };
  // 1. End to end: the target part's end node within reach (the nearer of the two).
  const [e0, e1] = hit.ends;
  const node = dist(end, e0) <= dist(end, e1) ? e0 : e1;
  if (dist(end, node) <= SNAP_ENDS_MM + EPS) {
    const r = result([...coords.slice(0, -1), round(node, endFlags)], "end");
    if (r) return r;
  }
  // An end already on the line (within the rounding to whole units) stays: cutting further back or moving it would
  // only re-snap what is snapped.
  if (hit.distanceMm <= ON_LINE_UNITS / u) return same;
  // 2. Overshoot: walk back from the end while the nodes stay within reach; cut at the first crossing met.
  for (let j = n - 2; j >= 0; j--) {
    if (!isAnchor(coords[j]) || distanceTo(hit.path, mm(coords[j + 1])) > SNAP_ENDS_MM + EPS) break;
    const x = crossingNearB(mm(coords[j]), mm(coords[j + 1]), hit.path);
    if (!x) continue;
    const r = result([...coords.slice(0, j + 1), round(x, endFlags)], "cut");
    if (r) return r;
    break;
  }
  // 3. Short (or a tail that leaves reach): the end node onto the nearest point.
  return result([...coords.slice(0, -1), round(hit.point, endFlags)], "moved") ?? same;
}

/** A path's order reversed with no flag rewriting (only positions are read; `snapLineEnds` sets the new start's flags). */
function reversedPlain(coords: readonly C[]): C[] {
  return [...coords].reverse();
}

/**
 * Both ends of an open line snapped, start first (each sees the other's result). `find` answers the nearest target
 * line to an end (never the line itself). Returns the coordinates (document units) and the number of ends moved.
 *
 * Flags: a moved or new end node keeps the old end's flags (its border bits cleared at the line's end, they cover
 * nothing); a new start node takes the border bits of the segment it now starts. Nodes cut off go with their flags.
 */
export function snapLineEnds(coords: readonly C[], find: FindLine, unitsPerMm: number): { coords: C[]; snapped: number; how: [EndSnap, EndSnap] } {
  // The start: snapped as the end of the reversed path, then put back in order.
  const rev = reversedPlain(coords);
  const s = snapLastEnd(rev, find, unitsPerMm);
  let out = coords as C[];
  if (s.how) {
    const back = reversedPlain(s.coords);
    // `back[0]` is the new start; the kept nodes are coords' last `back.length - 1`. Its border bits: the first kept
    // node's predecessor's (the segment it now starts was part of that one's).
    const kept = back.length - 1;
    const firstKept = coords.length - kept;
    const sides = flagsOf(coords[firstKept - 1]) & SIDES;
    const own = flagsOf(coords[0]) & ~SIDES & ~F.hole;
    back[0] = at(back[0][0], back[0][1], own | sides);
    out = back;
  }
  const e = snapLastEnd(out, find, unitsPerMm);
  out = e.coords;
  return { coords: out, snapped: (s.how ? 1 : 0) + (e.how ? 1 : 0), how: [s.how, e.how] };
}
