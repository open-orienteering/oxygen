/**
 * Snapping (docs/course-editor.md §6.2; 08 §5.3 "Snapping"): a control
 * centre snaps to the nearest point object's centre or line / area vertex
 * of the map document within 0.5 mm on paper.
 *
 * The candidates are document geometry — a point object's coordinate and
 * the on-curve vertices of lines and areas (Bézier control points are not
 * on the line) — read once per document into a uniform grid, on the main
 * thread like the editor's hit-test (§5): a snap is answered on every
 * pointer move of a drag, so it must not wait a worker round trip. Hidden
 * symbols and texts do not snap.
 *
 * The index is of the effective document (docs/map-patches.md §2.4): with
 * the event's patch, objects it hides do not snap and modified or added
 * ones snap where it puts them.
 */

import { mapDocument, render } from "@oxygen/shared";
import type { MapPatchDelivery } from "../map-document-cache";

type Pt = { x: number; y: number };

/** The snap distance on paper (08 §5.3). */
export const SNAP_MM = 0.5;

const CELL_MM = 2;
const BEZIER = render.COORD_FLAG.bezierFirst | render.COORD_FLAG.bezierSecond;

export interface SnapIndex {
  /** The nearest candidate within `maxMm` of `pt`, or null. */
  nearest(pt: Pt, maxMm?: number): Pt | null;
  readonly size: number;
}

/** Candidates from decoded document arrays (exported for tests with a hand-built document). */
export function snapIndexOf(doc: Pick<mapDocument.EffectiveDocument, "header" | "attrs" | "coords" | "flags" | "coordStart" | "hidden">): SnapIndex {
  const { header, attrs, coords, flags, coordStart, hidden } = doc;
  const u = header.unitsPerMm;
  const cells = new Map<string, number[]>();
  let size = 0;
  const add = (x: number, y: number) => {
    const key = `${Math.floor(x / CELL_MM)},${Math.floor(y / CELL_MM)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = []));
    cell.push(x, y);
    size++;
  };
  const n = attrs.symbolIdx.length;
  for (let i = 0; i < n; i++) {
    const type = attrs.type[i];
    if (type !== mapDocument.OBJECT_TYPE.point && type !== mapDocument.OBJECT_TYPE.line && type !== mapDocument.OBJECT_TYPE.area) continue;
    if (hidden?.[i]) continue;
    if (header.symbols[attrs.symbolIdx[i]]?.hidden) continue;
    for (let k = coordStart[i]; k < coordStart[i + 1]; k++) {
      if (flags[k] & BEZIER) continue;
      add(coords[k * 2] / u, coords[k * 2 + 1] / u);
      if (type === mapDocument.OBJECT_TYPE.point) break;
    }
  }
  return {
    size,
    nearest(pt, maxMm = SNAP_MM) {
      let best: Pt | null = null, bestD = maxMm;
      const r = Math.ceil(maxMm / CELL_MM);
      const cx = Math.floor(pt.x / CELL_MM), cy = Math.floor(pt.y / CELL_MM);
      for (let gx = cx - r; gx <= cx + r; gx++) {
        for (let gy = cy - r; gy <= cy + r; gy++) {
          const cell = cells.get(`${gx},${gy}`);
          if (!cell) continue;
          for (let j = 0; j < cell.length; j += 2) {
            const d = Math.hypot(cell[j] - pt.x, cell[j + 1] - pt.y);
            if (d <= bestD) { bestD = d; best = { x: cell[j], y: cell[j + 1] }; }
          }
        }
      }
      return best;
    },
  };
}

const cache = new Map<string, SnapIndex>();

/**
 * The index of a loaded document with the event's patch (`useMapPatch`), built on first use and
 * kept per hash and patch version. A patch keyed onto another document is not applied.
 */
export function snapIndexForDocument(hash: string, bytes: ArrayBuffer, patch?: MapPatchDelivery | null): SnapIndex {
  const p = patch?.patch && patch.patch.documentHash === hash ? patch : null;
  const key = `${hash}:${p ? p.version : "0"}`;
  let index = cache.get(key);
  if (!index) {
    const doc = mapDocument.decodeMapDocument(new Uint8Array(bytes));
    index = snapIndexOf(mapDocument.applyPatch(doc, p?.patch).document);
    cache.clear();
    cache.set(key, index);
  }
  return index;
}

// ─── The nearest point on a line (G28) ──

/** A line found by `nearestOnLines`: the nearest point on it, the part it lies on (paper mm) and that part's ends. */
export interface LineHit {
  /** The object's index in the document; -1 for a line not in it (a batch's earlier line, `nearestOnPath`). */
  object: number;
  point: Pt;
  distanceMm: number;
  /** The part the point is on, flattened (curves to 0.01 mm), paper mm. */
  path: Pt[];
  /** The part's first and last nodes. */
  ends: [Pt, Pt];
}

/** Curves of a target line are flattened to this (paper mm). */
const FLATTEN_MM = 0.01;
/** Floating-point slack on the inclusive reach (paper mm). */
const EPS_MM = 1e-9;

/** The nearest point of a polyline (paper mm) to `pt`, with its distance; null for an empty one. */
export function nearestOnPolyline(path: readonly Pt[], pt: Pt): { point: Pt; distanceMm: number } | null {
  if (path.length === 0) return null;
  let best = path[0], bestD = Math.hypot(path[0].x - pt.x, path[0].y - pt.y);
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(q.x - pt.x, q.y - pt.y);
    if (d < bestD) { bestD = d; best = q; }
  }
  return { point: best, distanceMm: bestD };
}

/** A line's parts (a `hole` flag starts the next), curves flattened, in paper mm; parts under two points are left out. */
export function lineParts(coords: ArrayLike<number>, flags: ArrayLike<number>, unitsPerMm: number): Pt[][] {
  if (flags.length === 0) return [];
  const rings = render.flattenRings(render.makePath(coords, flags), FLATTEN_MM * unitsPerMm);
  return rings.filter((r) => r.length >= 4).map((r) => {
    const out: Pt[] = [];
    for (let j = 0; j < r.length; j += 2) out.push({ x: r[j] / unitsPerMm, y: r[j + 1] / unitsPerMm });
    return out;
  });
}

function nearestOnParts(parts: readonly Pt[][], pt: Pt, maxMm: number, object: number): LineHit | null {
  let best: LineHit | null = null;
  for (const path of parts) {
    const n = nearestOnPolyline(path, pt);
    if (!n || n.distanceMm > maxMm + EPS_MM || (best && n.distanceMm >= best.distanceMm)) continue;
    best = { object, point: n.point, distanceMm: n.distanceMm, path, ends: [path[0], path[path.length - 1]] };
  }
  return best;
}

/** The nearest point within `maxMm` (inclusive) on one line given as document-unit coordinates (`object` -1). */
export function nearestOnPath(coords: readonly (readonly number[])[], unitsPerMm: number, pt: Pt, maxMm: number): LineHit | null {
  return nearestOnParts(lineParts(coords.flatMap((c) => [c[0], c[1]]), coords.map((c) => c[2] ?? 0), unitsPerMm), pt, maxMm, -1);
}

/**
 * The nearest point on a line object within `maxMm` of `pt` (paper mm, inclusive) among the lines whose symbol passes
 * `symbolFilter`, or null (docs/course-editor.md §6.2; row G28). The snap index above holds vertices only; this
 * answers a point anywhere on a line. Lines of the effective document, added ones included; hidden objects and hidden
 * symbols are not candidates, and neither is object `skip`. A linear scan with a bounding-box reject: it is asked
 * twice per line on a conversion or *Snap ends*, not on every pointer move. A tie goes to the lower index.
 */
export function nearestOnLines(
  doc: Pick<mapDocument.EffectiveDocument, "header" | "attrs" | "coords" | "flags" | "coordStart" | "hidden"> & { bboxes?: ArrayLike<number> },
  pt: Pt, maxMm: number, symbolFilter: (symbolIdx: number) => boolean, skip?: number,
): LineHit | null {
  const { header, attrs, coords, flags, coordStart, hidden, bboxes } = doc;
  const u = header.unitsPerMm;
  const reach = (maxMm + EPS_MM) * u + 1, px = pt.x * u, py = pt.y * u;
  let best: LineHit | null = null;
  for (let i = 0; i < attrs.symbolIdx.length; i++) {
    if (i === skip || attrs.type[i] !== mapDocument.OBJECT_TYPE.line || hidden?.[i]) continue;
    const s = attrs.symbolIdx[i];
    if (header.symbols[s]?.hidden || !symbolFilter(s)) continue;
    if (bboxes && (px < bboxes[i * 4] - reach || py < bboxes[i * 4 + 1] - reach || px > bboxes[i * 4 + 2] + reach || py > bboxes[i * 4 + 3] + reach)) continue;
    const from = coordStart[i], to = coordStart[i + 1];
    const hit = nearestOnParts(lineParts(coords.subarray(from * 2, to * 2), flags.subarray(from, to), u), pt, maxMm, i);
    if (hit && (!best || hit.distanceMm < best.distanceMm)) best = hit;
  }
  return best;
}
