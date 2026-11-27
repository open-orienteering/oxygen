/**
 * Dijkstra over the route grid (docs/course-elevation.md §7.7): the cost
 * of reaching every cell from one cell, in flat-forest metres, moving to
 * the eight neighbours. A diagonal move needs both cells it passes
 * between to be passable, so nothing slips through a barrier's corner.
 */

import { isBlockedClass, type CostModel } from "./cost-model.js";
import type { RouteGrid } from "./grid.js";

export interface CostField {
  /** Cost to each cell (Infinity where unreachable). */
  cost: Float64Array;
  /** The cell each cell was reached from; -1 at the origin and where unreachable. */
  prev: Int32Array;
}

const DC = [1, -1, 0, 0, 1, 1, -1, -1];
const DR = [0, 0, 1, -1, 1, -1, 1, -1];

/** The cost of the move a → b in the running direction: its ground length, the mean of the two cells' factors, the slope between them. */
export function moveCost(g: RouteGrid, model: CostModel, a: number, b: number, lengthM: number): number {
  const f = (model.classFactor[g.cls[a]] + model.classFactor[g.cls[b]]) / 2;
  if (!g.heights) return lengthM * f;
  const dz = g.heights[b] - g.heights[a];
  return lengthM * f * (Number.isNaN(dz) ? 1 : model.slopeFactor(dz / lengthM));
}

/**
 * `reverse`: the field of costs **to** `origin` from every cell (each
 * move is costed in its running direction, towards the origin).
 * `stopAt`: the search ends when that cell is settled; its cost and the
 * path to it are final then, cells farther away are left unreached.
 */
export function costField(g: RouteGrid, model: CostModel, origin: number, reverse = false, stopAt?: number): CostField {
  const n = g.cols * g.rows;
  const cost = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const stepM = g.cellMm * g.groundMPerMm;
  const diagM = stepM * Math.SQRT2;
  // A binary heap of (cost, cell); stale entries are skipped when popped.
  let heapCost = new Float64Array(1024);
  let heapCell = new Int32Array(1024);
  let size = 0;
  const push = (c: number, cell: number) => {
    if (size === heapCost.length) {
      const hc = new Float64Array(size * 2); hc.set(heapCost); heapCost = hc;
      const hi = new Int32Array(size * 2); hi.set(heapCell); heapCell = hi;
    }
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapCost[p] <= c) break;
      heapCost[i] = heapCost[p]; heapCell[i] = heapCell[p];
      i = p;
    }
    heapCost[i] = c; heapCell[i] = cell;
  };
  const pop = (): number => {
    const top = heapCell[0];
    const c = heapCost[--size], cell = heapCell[size];
    let i = 0;
    for (;;) {
      let k = i * 2 + 1;
      if (k >= size) break;
      if (k + 1 < size && heapCost[k + 1] < heapCost[k]) k++;
      if (heapCost[k] >= c) break;
      heapCost[i] = heapCost[k]; heapCell[i] = heapCell[k];
      i = k;
    }
    heapCost[i] = c; heapCell[i] = cell;
    return top;
  };
  if (isBlockedClass(g.cls[origin])) return { cost, prev };
  cost[origin] = 0;
  push(0, origin);
  while (size > 0) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === stopAt) break;
    const uc = u % g.cols, ur = (u - uc) / g.cols;
    for (let k = 0; k < 8; k++) {
      const vc = uc + DC[k], vr = ur + DR[k];
      if (vc < 0 || vr < 0 || vc >= g.cols || vr >= g.rows) continue;
      const v = vr * g.cols + vc;
      if (done[v] || isBlockedClass(g.cls[v])) continue;
      if (k >= 4 && (isBlockedClass(g.cls[ur * g.cols + vc]) || isBlockedClass(g.cls[vr * g.cols + uc]))) continue;
      const len = k >= 4 ? diagM : stepM;
      const c = cost[u] + (reverse ? moveCost(g, model, v, u, len) : moveCost(g, model, u, v, len));
      if (c < cost[v]) {
        cost[v] = c;
        prev[v] = u;
        push(c, v);
      }
    }
  }
  return { cost, prev };
}

/** The cells from `cell` back to the field's origin, `cell` first. */
export function tracePath(field: CostField, cell: number): number[] {
  const out: number[] = [];
  for (let c = cell; c >= 0; c = field.prev[c]) out.push(c);
  return out;
}
