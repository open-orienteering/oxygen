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
 */

import { mapDocument, render } from "@oxygen/shared";

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
export function snapIndexOf(doc: Pick<mapDocument.MapDocument, "header" | "attrs" | "coords" | "flags" | "coordStart">): SnapIndex {
  const { header, attrs, coords, flags, coordStart } = doc;
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

/** The index of a loaded document, built on first use and kept per hash. */
export function snapIndexForDocument(hash: string, bytes: ArrayBuffer): SnapIndex {
  let index = cache.get(hash);
  if (!index) {
    index = snapIndexOf(mapDocument.decodeMapDocument(new Uint8Array(bytes)));
    cache.clear();
    cache.set(hash, index);
  }
  return index;
}
