/**
 * The route search's grid (docs/course-elevation.md §7.6): a window of
 * the map as square cells, each with a cost class and a height.
 */

import { BLOCKED, BLOCKED_SOFT, CLASS_PRIORITY, WAY_CLASSES, isBlockedClass } from "./cost-model.js";

export interface RoutePoint { x: number; y: number }

/** A classified map object: an area's rings (holes included; filled even-odd) or a line's parts, flat `[x0, y0, …]` paper mm. */
export interface RouteFeature {
  cls: number;
  kind: "area" | "line";
  parts: readonly ArrayLike<number>[];
}

export interface RouteGrid {
  /** Paper mm of the corner of cell (0, 0). */
  x0: number;
  y0: number;
  cellMm: number;
  cols: number;
  rows: number;
  groundMPerMm: number;
  /** Cost class index per cell (row-major). */
  cls: Uint8Array;
  /** Height in metres at each cell's centre, NaN where unknown; null without a field. */
  heights: Float32Array | null;
}

export interface RouteGridInput {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  cellMm: number;
  groundMPerMm: number;
  features: readonly RouteFeature[];
  /** Heights at paper points (metres, null where unknown). */
  heightAt?: ((p: RoutePoint) => number | null) | null;
}

export const cellOf = (g: Pick<RouteGrid, "x0" | "y0" | "cellMm" | "cols" | "rows">, p: RoutePoint): number => {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor((p.x - g.x0) / g.cellMm)));
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor((p.y - g.y0) / g.cellMm)));
  return r * g.cols + c;
};
export const centreOf = (g: Pick<RouteGrid, "x0" | "y0" | "cellMm" | "cols">, cell: number): RoutePoint => ({
  x: g.x0 + ((cell % g.cols) + 0.5) * g.cellMm,
  y: g.y0 + (Math.floor(cell / g.cols) + 0.5) * g.cellMm,
});

/** Even-odd scanline fill of an area's rings: every cell whose centre is inside takes `cls` when it outranks what is there. */
function fillArea(g: RouteGrid, parts: readonly ArrayLike<number>[], cls: number): void {
  const rows: number[][] = [];
  let rMin = g.rows, rMax = -1;
  for (const p of parts) {
    const n = p.length / 2;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
      if (ay === by) continue;
      if (ay > by) { const tx = ax, ty = ay; ax = bx; ay = by; bx = tx; by = ty; }
      // Rows whose centre y lies in [ay, by).
      const r0 = Math.max(0, Math.ceil((ay - g.y0) / g.cellMm - 0.5));
      const r1 = Math.min(g.rows - 1, Math.ceil((by - g.y0) / g.cellMm - 0.5) - 1);
      for (let r = r0; r <= r1; r++) {
        const y = g.y0 + (r + 0.5) * g.cellMm;
        (rows[r] ??= []).push(ax + ((y - ay) / (by - ay)) * (bx - ax));
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
      }
    }
  }
  const rank = CLASS_PRIORITY[cls];
  for (let r = rMin; r <= rMax; r++) {
    const xs = rows[r];
    if (!xs) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Cells whose centre x lies in [xs[k], xs[k + 1]).
      const c0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cellMm - 0.5));
      const c1 = Math.min(g.cols - 1, Math.ceil((xs[k + 1] - g.x0) / g.cellMm - 0.5) - 1);
      for (let c = c0; c <= c1; c++) {
        const i = r * g.cols + c;
        if (rank >= CLASS_PRIORITY[g.cls[i]]) g.cls[i] = cls;
      }
    }
  }
}

/** Every cell a polyline touches, 4-connected (no diagonal step a runner could slip through), handed to `mark`. */
function walkLine(g: RouteGrid, p: ArrayLike<number>, mark: (cell: number) => void): void {
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < g.cols && r < g.rows;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = (p[i] - g.x0) / g.cellMm, ay = (p[i + 1] - g.y0) / g.cellMm;
    const bx = (p[i + 2] - g.x0) / g.cellMm, by = (p[i + 3] - g.y0) / g.cellMm;
    // Wholly outside on one side: nothing to mark.
    if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax >= g.cols && bx >= g.cols) || (ay >= g.rows && by >= g.rows)) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 4));
    let pc = Math.floor(ax), pr = Math.floor(ay);
    if (inside(pc, pr)) mark(pr * g.cols + pc);
    for (let s = 1; s <= steps; s++) {
      const c = Math.floor(ax + ((bx - ax) * s) / steps), r = Math.floor(ay + ((by - ay) * s) / steps);
      if (c === pc && r === pr) continue;
      if (c !== pc && r !== pr && inside(c, pr)) mark(pr * g.cols + c);
      if (inside(c, r)) mark(r * g.cols + c);
      pc = c;
      pr = r;
    }
  }
}

/** A ring whose mean width is under this many cells is walked along its outline. */
export const THIN_RING_CELLS = 1.5;

/** A ring's mean width, paper mm: twice its area over its perimeter. */
export function meanWidthMm(ring: ArrayLike<number>): number {
  let area = 0, perimeter = 0;
  const n = Math.floor(ring.length / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
    perimeter += Math.hypot(ring[2 * j] - ring[2 * i], ring[2 * j + 1] - ring[2 * i + 1]);
  }
  return perimeter > 0 ? Math.abs(area) / perimeter : 0;
}

/**
 * Areas first, by rank, the thin uncrossable ones with their outlines; then
 * ways (a path opens everything but the hard uncrossable: over water it
 * is a bridge); then hard uncrossable lines, which nothing opens.
 */
export function buildRouteGrid(input: RouteGridInput): RouteGrid {
  const { bounds, cellMm } = input;
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellMm));
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellMm));
  const g: RouteGrid = { x0: bounds.minX, y0: bounds.minY, cellMm, cols, rows, groundMPerMm: input.groundMPerMm, cls: new Uint8Array(cols * rows), heights: null };
  for (const f of input.features) if (f.kind === "area") fillArea(g, f.parts, f.cls);
  // A thin uncrossable ring's outline too: one narrower than a cell holds no cell centre and would not be on the
  // grid. A wide one is its filled cells alone, so the passage between two buildings stays as wide as it is drawn.
  // Uncrossable water's bank lines are walked as well: a way laid over them afterwards is still a bridge.
  const rank = (i: number, cls: number) => { if (CLASS_PRIORITY[cls] >= CLASS_PRIORITY[g.cls[i]]) g.cls[i] = cls; };
  for (const f of input.features) {
    if (!isBlockedClass(f.cls) || (f.kind === "line" && f.cls !== BLOCKED_SOFT)) continue;
    for (const p of f.parts) {
      if (p.length < 4 || (f.kind === "area" && meanWidthMm(p) >= THIN_RING_CELLS * cellMm)) continue;
      walkLine(g, f.kind === "area" ? [...Array.from(p), p[0], p[1]] : p, (i) => rank(i, f.cls));
    }
  }
  for (const f of input.features) {
    if (f.kind !== "line" || !WAY_CLASSES.has(f.cls)) continue;
    for (const p of f.parts) walkLine(g, p, (i) => { if (g.cls[i] !== BLOCKED) g.cls[i] = f.cls; });
  }
  for (const f of input.features) {
    if (f.kind !== "line" || f.cls !== BLOCKED) continue;
    for (const p of f.parts) walkLine(g, p, (i) => { g.cls[i] = BLOCKED; });
  }
  if (input.heightAt) {
    const h = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const z = input.heightAt({ x: g.x0 + (c + 0.5) * cellMm, y: g.y0 + (r + 0.5) * cellMm });
        h[r * cols + c] = z === null ? Number.NaN : z;
      }
    }
    g.heights = h;
  }
  return g;
}

/** Opens the cells within `radiusMm` of a point: a crossing point is where a leg passes an obstacle (course-layer.md §9.3). */
export function openDisc(g: RouteGrid, at: RoutePoint, radiusMm: number, cls: number): void {
  const reach = Math.ceil(radiusMm / g.cellMm) + 1;
  const c0 = Math.floor((at.x - g.x0) / g.cellMm), r0 = Math.floor((at.y - g.y0) / g.cellMm);
  for (let r = Math.max(0, r0 - reach); r <= Math.min(g.rows - 1, r0 + reach); r++) {
    for (let c = Math.max(0, c0 - reach); c <= Math.min(g.cols - 1, c0 + reach); c++) {
      const p = centreOf(g, r * g.cols + c);
      if (Math.hypot(p.x - at.x, p.y - at.y) <= radiusMm + g.cellMm * 0.5 && isBlockedClass(g.cls[r * g.cols + c])) g.cls[r * g.cols + c] = cls;
    }
  }
}

/**
 * The passable cell nearest to `cell` (itself when passable), searching rings up to `maxRings` cells out; -1 when
 * none. With `at`, the point in `cell` that is meant, the nearest is measured from the point: a control beside a
 * fence in the fence's cell is run to from its own side.
 */
export function nearestPassable(g: RouteGrid, cell: number, maxRings = 12, at?: RoutePoint): number {
  if (!isBlockedClass(g.cls[cell])) return cell;
  const c0 = at ? (at.x - g.x0) / g.cellMm - 0.5 : cell % g.cols, r0 = at ? (at.y - g.y0) / g.cellMm - 0.5 : Math.floor(cell / g.cols);
  const cc = cell % g.cols, rc = Math.floor(cell / g.cols);
  for (let ring = 1; ring <= maxRings; ring++) {
    let best = -1, bestD = Infinity;
    for (let r = rc - ring; r <= rc + ring; r++) {
      for (let c = cc - ring; c <= cc + ring; c++) {
        if (Math.max(Math.abs(r - rc), Math.abs(c - cc)) !== ring || c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const i = r * g.cols + c;
        const d = (r - r0) ** 2 + (c - c0) ** 2;
        if (!isBlockedClass(g.cls[i]) && d < bestD) { best = i; bestD = d; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** The height at a paper point, bilinear between the cell centres around it; NaN where a neighbour is unknown or without a field. */
export function heightAtPoint(g: RouteGrid, p: RoutePoint): number {
  if (!g.heights) return Number.NaN;
  const fx = Math.min(g.cols - 1, Math.max(0, (p.x - g.x0) / g.cellMm - 0.5));
  const fy = Math.min(g.rows - 1, Math.max(0, (p.y - g.y0) / g.cellMm - 0.5));
  const c0 = Math.floor(fx), r0 = Math.floor(fy);
  const c1 = Math.min(g.cols - 1, c0 + 1), r1 = Math.min(g.rows - 1, r0 + 1);
  const tx = fx - c0, ty = fy - r0;
  const h = g.heights;
  return (h[r0 * g.cols + c0] * (1 - tx) + h[r0 * g.cols + c1] * tx) * (1 - ty) + (h[r1 * g.cols + c0] * (1 - tx) + h[r1 * g.cols + c1] * tx) * ty;
}

export { BLOCKED, BLOCKED_SOFT };
