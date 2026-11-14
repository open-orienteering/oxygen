/**
 * Contour ladders: candidates, the evidence grid, the vote per chain, the
 * local phase and the ladder areas (docs/map-terrain.md §6.6–6.7).
 */

import { walkPolyline } from "../graph/flatten.js";
import { circularDev, circularDist, mod } from "./interval.js";
import { ANCHOR_RULES } from "./types.js";

const L = ANCHOR_RULES.ladder;
const V = ANCHOR_RULES.vote;

/**
 * Candidate ladder phases in [0, I), strongest first: peaks of a
 * length-weighted circular density of `median mod I` (§6.6 step 1).
 */
export function candidateLadders(median: ArrayLike<number>, weight: ArrayLike<number>, I: number): number[] {
  const idx: number[] = [];
  let total = 0;
  for (let i = 0; i < median.length; i++) {
    if (weight[i] > 0 && !Number.isNaN(median[i])) {
      idx.push(i);
      total += weight[i];
    }
  }
  if (total <= 0) return [];
  const bins = L.bins;
  const density = new Float64Array(bins);
  const s2 = 2 * (L.sigma * I) ** 2;
  for (let b = 0; b < bins; b++) {
    const c = (b * I) / bins;
    let d = 0;
    for (const i of idx) d += weight[i] * Math.exp(-(circularDist(median[i], c, I) ** 2) / s2);
    density[b] = d;
  }
  const peaks: number[] = [];
  for (let b = 0; b < bins; b++) {
    const prev = density[(b + bins - 1) % bins];
    const next = density[(b + 1) % bins];
    if (density[b] > prev && density[b] >= next) peaks.push(b);
  }
  peaks.sort((a, b) => density[b] - density[a] || a - b);
  const kept: number[] = [];
  for (const b of peaks) {
    if (kept.length >= L.maxLadders) break;
    const c = (b * I) / bins;
    let mass = 0, re = 0, im = 0;
    for (const i of idx) {
      if (circularDist(median[i], c, I) > L.massWindow * I) continue;
      mass += weight[i];
      const a = (2 * Math.PI * median[i]) / I;
      re += weight[i] * Math.cos(a);
      im += weight[i] * Math.sin(a);
    }
    if (mass < L.massMin * total) continue;
    const phase = mod((Math.atan2(im, re) / (2 * Math.PI)) * I, I);
    if (kept.some((p) => circularDist(phase, p, I) < L.separation * I)) continue;
    kept.push(phase);
  }
  return kept;
}

export interface VoteChain {
  pts: Float64Array;
  closed: boolean;
}

export interface VoteInput {
  chains: VoteChain[];
  groundMPerMm: number;
  intervalM: number;
  /** Per chain, metres; NaN when unknown. */
  median: Float64Array;
  /** Per chain: 1 when it contributes to the ladders (§6.5). */
  contributor: Uint8Array;
}

export interface VoteArea {
  ladder: number;
  cells: number;
  /** Own-ladder evidence in the area's cells, ground metres. */
  evidenceM: number;
}

export interface LadderVote {
  ladders: { phaseM: number; lengthMm: number }[];
  /** Per chain: the ladder it is a member of; −1 none. */
  member: Int32Array;
  /** Per chain: the winning ladder; −1 unlabelled. */
  label: Int32Array;
  /** Per chain: the winner's share of the window's evidence (0 without evidence). */
  share: Float64Array;
  /** Per chain: the window's evidence, ground metres (own removed). */
  evidenceM: Float64Array;
  /** Per chain: local phase, metres; NaN unlabelled. */
  phase: Float64Array;
  /** Per chain: ladder area; −1 none. */
  area: Int32Array;
  areas: VoteArea[];
  /** The evidence grid, its cells' areas, and every chain's ground metres per cell. */
  grid: CellGrid;
  cellArea: Int32Array;
  chainCells: Map<number, number>[];
  /** Length of the contributors labelled, over the contributors' length (§6.5 intervalSuspect). */
  labelledContributorShare: number;
}

export interface CellGrid {
  x0: number;
  y0: number;
  cellMm: number;
  width: number;
  height: number;
}

/** The chain's ground metres per cell, in walk order of first visit. */
function chainCells(c: VoteChain, grid: CellGrid, stepMm: number, stepM: number): Map<number, number> {
  const cells = new Map<number, number>();
  walkPolyline(c.pts, c.closed, stepMm, (x, y) => {
    const cx = Math.min(grid.width - 1, Math.max(0, Math.floor((x - grid.x0) / grid.cellMm)));
    const cy = Math.min(grid.height - 1, Math.max(0, Math.floor((y - grid.y0) / grid.cellMm)));
    const k = cy * grid.width + cx;
    cells.set(k, (cells.get(k) ?? 0) + stepM);
  });
  return cells;
}

/** Summed-area table of a width × height grid, (width + 1) × (height + 1). */
function summedArea(v: Float64Array, w: number, h: number): Float64Array {
  const s = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += v[y * w + x];
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
    }
  }
  return s;
}

function windowSum(s: Float64Array, w: number, h: number, cx: number, cy: number, r: number): number {
  const xa = Math.max(0, cx - r), xb = Math.min(w - 1, cx + r);
  const ya = Math.max(0, cy - r), yb = Math.min(h - 1, cy + r);
  const W = w + 1;
  return s[(yb + 1) * W + xb + 1] - s[ya * W + xb + 1] - s[(yb + 1) * W + xa] + s[ya * W + xa];
}

/** §6.6–6.7: candidates, members, the vote per chain, local phases and areas. */
export function ladderVote(input: VoteInput): LadderVote {
  const { chains, groundMPerMm: g, intervalM: I, median, contributor } = input;
  const n = chains.length;
  const stepM = ANCHOR_RULES.sampleStepM;
  const stepMm = stepM / g;
  const empty = (): LadderVote => ({
    ladders: [],
    member: new Int32Array(n).fill(-1),
    label: new Int32Array(n).fill(-1),
    share: new Float64Array(n),
    evidenceM: new Float64Array(n),
    phase: new Float64Array(n).fill(NaN),
    area: new Int32Array(n).fill(-1),
    areas: [],
    grid: { x0: 0, y0: 0, cellMm: 1, width: 0, height: 0 },
    cellArea: new Int32Array(0),
    chainCells: chains.map(() => new Map<number, number>()),
    labelledContributorShare: 0,
  });

  // Grid over the chains' bounding box.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of chains) {
    for (let i = 0; i < c.pts.length; i += 2) {
      x0 = Math.min(x0, c.pts[i]);
      x1 = Math.max(x1, c.pts[i]);
      y0 = Math.min(y0, c.pts[i + 1]);
      y1 = Math.max(y1, c.pts[i + 1]);
    }
  }
  if (!(x1 >= x0)) return empty();
  const cellMm = V.cellM / g;
  const grid: CellGrid = { x0, y0, cellMm, width: Math.floor((x1 - x0) / cellMm) + 1, height: Math.floor((y1 - y0) / cellMm) + 1 };
  const W = grid.width, H = grid.height;
  const cells = chains.map((c) => chainCells(c, grid, stepMm, stepM));
  const lengthM = cells.map((m) => {
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
  });

  // Candidates and members (§6.6 steps 1–2).
  const weight = new Float64Array(n);
  for (let i = 0; i < n; i++) if (contributor[i]) weight[i] = lengthM[i];
  const phases = candidateLadders(median, weight, I);
  const out = empty();
  out.grid = grid;
  out.chainCells = cells;
  out.cellArea = new Int32Array(W * H).fill(-1);
  if (!phases.length) return out;
  const K = phases.length;
  const dev = new Float64Array(n);
  const ladderLen = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    if (!(weight[i] > 0)) continue;
    let best = -1, bd = Infinity;
    for (let l = 0; l < K; l++) {
      const d = circularDist(median[i], phases[l], I);
      if (d <= L.memberWithin * I && d < bd) {
        bd = d;
        best = l;
      }
    }
    out.member[i] = best;
    if (best >= 0) {
      dev[i] = circularDev(median[i], phases[best], I);
      ladderLen[best] += lengthM[i];
    }
  }
  out.ladders = phases.map((p, l) => ({ phaseM: p, lengthMm: ladderLen[l] / g }));

  // Evidence grid (§6.6 step 3).
  const ev = Array.from({ length: K }, () => new Float64Array(W * H));
  const dv = Array.from({ length: K }, () => new Float64Array(W * H));
  for (let i = 0; i < n; i++) {
    const l = out.member[i];
    if (l < 0) continue;
    for (const [k, m] of cells[i]) {
      ev[l][k] += m;
      dv[l][k] += m * dev[i];
    }
  }
  const evS = ev.map((v) => summedArea(v, W, H));
  const dvS = dv.map((v) => summedArea(v, W, H));

  // Vote per chain (§6.6 step 4) and local phase (§6.7).
  const E = new Float64Array(K), D = new Float64Array(K);
  let contribLen = 0, contribLabelled = 0;
  for (let i = 0; i < n; i++) {
    const own = cells[i];
    const total = lengthM[i];
    if (total <= 0) continue;
    const ml = out.member[i];
    const keys = [...own.keys()];
    let T = 0;
    for (let r = V.minRadius; r <= V.maxRadius; r++) {
      E.fill(0);
      D.fill(0);
      for (const k of keys) {
        const f = own.get(k)! / total;
        const cx = k % W, cy = (k - cx) / W;
        for (let l = 0; l < K; l++) {
          E[l] += f * windowSum(evS[l], W, H, cx, cy, r);
          D[l] += f * windowSum(dvS[l], W, H, cx, cy, r);
        }
        if (ml >= 0) {
          // The chain's own length within this cell's window.
          let o = 0;
          for (const k2 of keys) {
            const x2 = k2 % W, y2 = (k2 - x2) / W;
            if (Math.abs(x2 - cx) <= r && Math.abs(y2 - cy) <= r) o += own.get(k2)!;
          }
          E[ml] -= f * o;
          D[ml] -= f * o * dev[i];
        }
      }
      T = 0;
      for (let l = 0; l < K; l++) {
        if (E[l] < 1e-9) E[l] = 0;
        T += E[l];
      }
      if (T >= V.enoughM) break;
    }
    let win = -1;
    for (let l = 0; l < K; l++) if (win < 0 || E[l] > E[win]) win = l;
    out.evidenceM[i] = T;
    out.share[i] = T > 0 ? E[win] / T : 0;
    if (T >= V.minEvidenceM && out.share[i] >= V.winShare) {
      out.label[i] = win;
      out.phase[i] = phases[win] + D[win] / E[win];
    }
    if (contributor[i]) {
      contribLen += total;
      if (out.label[i] >= 0) contribLabelled += total;
    }
  }
  out.labelledContributorShare = contribLen > 0 ? contribLabelled / contribLen : 0;

  // Ladder areas (§6.7): every cell voted with all evidence, 4-connected per ladder.
  const cellLabel = new Int32Array(W * H).fill(-1);
  for (let k = 0; k < W * H; k++) {
    const cx = k % W, cy = (k - cx) / W;
    cellLabel[k] = cellVote(evS, W, H, cx, cy, E);
  }
  const comp = components(cellLabel, W, H);
  const cellArea = comp.id;
  const raw: VoteArea[] = Array.from({ length: comp.count }, () => ({ ladder: -1, cells: 0, evidenceM: 0 }));
  for (let k = 0; k < W * H; k++) {
    const c = cellArea[k];
    if (c < 0) continue;
    const l = cellLabel[k];
    raw[c].ladder = l;
    raw[c].cells++;
    raw[c].evidenceM += ev[l][k];
  }
  // Dissolve thin areas and renumber the rest in order.
  const remap = new Int32Array(raw.length).fill(-1);
  raw.forEach((a, i) => {
    if (a.evidenceM >= ANCHOR_RULES.areaMinM) {
      remap[i] = out.areas.length;
      out.areas.push(a);
    }
  });
  for (let k = 0; k < W * H; k++) if (cellArea[k] >= 0) cellArea[k] = remap[cellArea[k]];
  out.cellArea = cellArea;
  out.area = chainAreas(cells, cellArea);
  return out;
}

/** A chain's area: the one holding most of its length; −1 none (§6.7). */
function chainAreas(cells: Map<number, number>[], cellArea: Int32Array): Int32Array {
  const area = new Int32Array(cells.length).fill(-1);
  const byArea = new Map<number, number>();
  for (let i = 0; i < cells.length; i++) {
    byArea.clear();
    for (const [k, m] of cells[i]) {
      const a = cellArea[k];
      if (a >= 0) byArea.set(a, (byArea.get(a) ?? 0) + m);
    }
    let best = -1, bm = 0;
    for (const [a, m] of byArea) {
      if (m > bm || (m === bm && a < best)) {
        best = a;
        bm = m;
      }
    }
    area[i] = best;
  }
  return area;
}

/** Adaptive-window vote over `K` summed-area tables centred on one cell: the winner, or −1 (§6.6 step 4 rules). */
function cellVote(sats: Float64Array[], W: number, H: number, cx: number, cy: number, E: Float64Array): number {
  const K = sats.length;
  let T = 0;
  for (let r = V.minRadius; r <= V.maxRadius; r++) {
    T = 0;
    for (let l = 0; l < K; l++) {
      E[l] = windowSum(sats[l], W, H, cx, cy, r);
      T += E[l];
    }
    if (T >= V.enoughM) break;
  }
  let win = 0;
  for (let l = 1; l < K; l++) if (E[l] > E[win]) win = l;
  return T >= V.minEvidenceM && E[win] / T >= V.winShare ? win : -1;
}

/** 4-connected components of equal non-negative `label` (row-major from the lower-left); −1 elsewhere. */
function components(label: Int32Array, W: number, H: number): { id: Int32Array; count: number } {
  const id = new Int32Array(W * H).fill(-1);
  const stack: number[] = [];
  let count = 0;
  for (let k0 = 0; k0 < W * H; k0++) {
    if (label[k0] < 0 || id[k0] >= 0) continue;
    const l = label[k0];
    id[k0] = count;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop()!;
      const cx = k % W, cy = (k - cx) / W;
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k2 = ny * W + nx;
        if (label[k2] === l && id[k2] < 0) {
          id[k2] = count;
          stack.push(k2);
        }
      }
    }
    count++;
  }
  return { id, count };
}

/**
 * §6.7: ladder areas split by index residue. Within each area every cell
 * votes among the residues of the snapped index chains of that area (the
 * same adaptive window); the cells of one area and one residue (or of no
 * residue) form sub-areas by 4-connection; a sub-area with less own-ladder
 * evidence than the area minimum is dissolved.
 */
export function splitAreasByResidue(vote: LadderVote, residue: Int32Array, residues: number): { areas: VoteArea[]; area: Int32Array; cellArea: Int32Array } {
  const { width: W, height: H } = vote.grid;
  const A = vote.areas.length;
  const cellRes = new Int32Array(W * H).fill(-1);
  const E = new Float64Array(residues);
  for (let a = 0; a < A; a++) {
    const ev = Array.from({ length: residues }, () => new Float64Array(W * H));
    let any = false;
    for (let i = 0; i < residue.length; i++) {
      if (residue[i] < 0 || vote.area[i] !== a) continue;
      for (const [k, m] of vote.chainCells[i]) {
        if (vote.cellArea[k] !== a) continue;
        ev[residue[i]][k] += m;
        any = true;
      }
    }
    if (!any) continue;
    const sats = ev.map((v) => summedArea(v, W, H));
    for (let k = 0; k < W * H; k++) {
      if (vote.cellArea[k] !== a) continue;
      const cx = k % W, cy = (k - cx) / W;
      cellRes[k] = cellVote(sats, W, H, cx, cy, E);
    }
  }
  // Label (area, residue) with residue −1 as its own value.
  const label = new Int32Array(W * H).fill(-1);
  for (let k = 0; k < W * H; k++) if (vote.cellArea[k] >= 0) label[k] = vote.cellArea[k] * (residues + 1) + cellRes[k] + 1;
  const comp = components(label, W, H);
  const raw: VoteArea[] = Array.from({ length: comp.count }, () => ({ ladder: -1, cells: 0, evidenceM: 0 }));
  // Own-ladder evidence per cell, from the chains labelled with the area's ladder.
  const ladderEv = new Float64Array(W * H);
  for (let i = 0; i < vote.member.length; i++) {
    if (vote.member[i] < 0) continue;
    for (const [k, m] of vote.chainCells[i]) {
      const a = vote.cellArea[k];
      if (a >= 0 && vote.areas[a].ladder === vote.member[i]) ladderEv[k] += m;
    }
  }
  for (let k = 0; k < W * H; k++) {
    const c = comp.id[k];
    if (c < 0) continue;
    raw[c].ladder = vote.areas[vote.cellArea[k]].ladder;
    raw[c].cells++;
    raw[c].evidenceM += ladderEv[k];
  }
  const remap = new Int32Array(comp.count).fill(-1);
  const areas: VoteArea[] = [];
  raw.forEach((a, i) => {
    if (a.evidenceM >= ANCHOR_RULES.areaMinM) {
      remap[i] = areas.length;
      areas.push(a);
    }
  });
  const cellArea = new Int32Array(W * H).fill(-1);
  for (let k = 0; k < W * H; k++) if (comp.id[k] >= 0) cellArea[k] = remap[comp.id[k]];
  return { areas, area: chainAreas(vote.chainCells, cellArea), cellArea };
}
