/**
 * The DEM for a document (docs/map-terrain.md §7.3–7.5): its extent
 * through `mapGeo`, the tiles' windows fetched by range, and the paper
 * sampler the anchor and the ground field read.
 *
 * Paper is the terrain chapter's unit: mm, y up; `mm · unitsPerMm` is the
 * document's native unit that `mapGeo.paperToProjected` takes. The DEM is
 * fetched through the document's own frame, `correctionDeg` 0 (§7.0
 * answer 2). The fetch runs on the main thread (an injected fetch cannot
 * cross into a worker); the sampler is built in the worker from the
 * windows, so the derive holds no event loop.
 */

import { mapGeo } from "@oxygen/shared";
import { RASTER_RULES } from "@oxygen/shared/src/terrain/graph/raster.js";
import { chooseLevel, coarserLevel, cogWindowCells, DemFetchError, overCapError, readCogInfo, readCogWindow, sampleWindow, type CogInfo, type CogWindow } from "./dem-cog.js";
import type { DemProvider } from "./dem-providers.js";

export const DEM_RULES = {
  /** Ground margin around the contours' box: the anchor's ±8 m probes and its 5 m stencil, with room (§6.3). */
  marginM: 30,
  /** Cells of all windows of one document together (float32: 256 MB). */
  maxMosaicCells: 64_000_000,
  /** The paper grid the sampler reads: at most this many cells, at most this ground cell. */
  maxPaperCells: 64_000_000,
  maxPaperCellM: 10,
  /** Lattice nodes for the exact transform, at most this far apart on the ground (bilinear between: < 0.05 m, §7.3). */
  latticeM: 250,
  /** Points per box edge projected to bound a curved edge. */
  edgeSamples: 8,
} as const;

export interface PaperBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DemExtent {
  /** Paper mm: the document's bounds, the graph raster's pad and the ground margin. */
  paper: PaperBox;
  wgs84: mapGeo.Wgs84Bounds;
  /** Ground metres per paper mm. */
  groundMPerMm: number;
}

interface HeaderSummary {
  unitsPerMm?: unknown;
  bounds?: { minX?: unknown; minY?: unknown; maxX?: unknown; maxY?: unknown } | null;
}

/** Paper mm → the raster CRS, through the frame and proj4 when the CRS differs; null when it does not project. */
export function paperToCrs(frame: mapGeo.PaperFrame, epsg: number): ((xMm: number, yMm: number) => [number, number] | null) | null {
  const from = mapGeo.epsgOf(frame), to = mapGeo.epsgName(epsg);
  if (!from || !to) return null;
  const u = frame.unitsPerMm;
  const p = from === to ? null : mapGeo.proj()(from, to);
  return (x, y) => {
    const e = mapGeo.paperToProjected(frame, x * u, y * u);
    if (!e) return null;
    if (!p) return e;
    try {
      const out = p.forward(e);
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? [out[0], out[1]] : null;
    } catch {
      return null;
    }
  };
}

/** Points along the box's edges. */
function edgePoints(b: PaperBox, n: number = DEM_RULES.edgeSamples): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = b.minX + t * (b.maxX - b.minX), y = b.minY + t * (b.maxY - b.minY);
    out.push([x, b.minY], [x, b.maxY], [b.minX, y], [b.maxX, y]);
  }
  return out;
}

/** The box of the paper box in a CRS (min/max over its projected edges); null when a point does not project. */
export function boxInCrs(frame: mapGeo.PaperFrame, paper: PaperBox, epsg: number): PaperBox | null {
  const f = paperToCrs(frame, epsg);
  if (!f) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of edgePoints(paper)) {
    const p = f(x, y);
    if (!p) return null;
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * §7.3: the extent to fetch — the stored header summary's bounds, padded
 * by the graph raster's 2 mm and 30 m of ground. Null without a CRS proj4
 * knows, a paper origin, or usable bounds (`no-georeference`).
 */
export function documentDemExtent(frame: mapGeo.PaperFrame, summary: unknown): DemExtent | null {
  if (!mapGeo.epsgOf(frame)) return null;
  const s = (summary ?? {}) as HeaderSummary;
  const u = typeof s.unitsPerMm === "number" && s.unitsPerMm > 0 ? s.unitsPerMm : null;
  const b = s.bounds;
  if (!u || !b) return null;
  const { minX, minY, maxX, maxY } = b;
  if (typeof minX !== "number" || typeof minY !== "number" || typeof maxX !== "number" || typeof maxY !== "number" || !(maxX >= minX) || !(maxY >= minY)) return null;
  const groundMPerMm = frame.mapScale / 1000;
  const pad = RASTER_RULES.padMm + DEM_RULES.marginM / groundMPerMm;
  const paper = { minX: minX / u - pad, minY: minY / u - pad, maxX: maxX / u + pad, maxY: maxY / u + pad };
  const ll = boxInCrs(frame, paper, 4326);
  if (!ll) return null;
  return { paper, groundMPerMm, wgs84: { west: ll.minX, south: ll.minY, east: ll.maxX, north: ll.maxY } };
}

export interface DemMosaic {
  windows: CogWindow[];
  /** Tiles located, and those that held part of the extent. */
  tiles: number;
  tilesRead: number;
  /** Ground cell of the level read, metres: the provider's, or the next coarser overview's when its own was over the cap (§7.0c answer 12). */
  resolutionM: number;
  /** Whether the next coarser overview was read. */
  stepped: boolean;
}

const mCells = (n: number) => `${(n / 1e6).toFixed(1)} M`;
const metres = (m: number) => `${Number(m.toPrecision(3))} m`;

/**
 * §7.2: the provider's tiles over the extent, each read at the provider's
 * level as a window of the extent's box in the tile's CRS. The windows
 * are sized from the tiles' headers first: over the cap at that level,
 * every tile is read at its next coarser overview instead (§7.0c answer
 * 12; one step, the same tiles; `coarser: false` turns it off, the live
 * check's 1 m / 2 m comparison). `no-coverage` when the provider has no
 * tile there, or none holds any of it. Throws `DemFetchError`.
 */
export async function fetchDemMosaic(provider: DemProvider, frame: mapGeo.PaperFrame, extent: DemExtent, opts: { maxCells?: number; coarser?: boolean } = {}): Promise<DemMosaic | "no-coverage"> {
  const tiles = await provider.locate(extent.wgs84);
  if (tiles === "no-coverage") return tiles;
  const cap = opts.maxCells ?? DEM_RULES.maxMosaicCells;
  // the headers and boxes of every tile first: the level is decided for the whole mosaic
  const plan: { src: { fetch: DemProvider["fetch"]; url: string }; info: CogInfo; box: PaperBox; level: number }[] = [];
  for (const tile of tiles) {
    const src = { fetch: provider.fetch, url: tile.url };
    let info;
    try {
      info = await readCogInfo(src);
    } catch (err: unknown) {
      if (provider.missingTileIsNoData && err instanceof DemFetchError && (err.status === 404 || err.status === 403)) continue;
      throw err;
    }
    const box = boxInCrs(frame, extent.paper, info.epsg);
    if (!box) throw new DemFetchError("format", `the document does not project into the tile's EPSG:${info.epsg}`);
    plan.push({ src, info, box, level: chooseLevel(info, provider.targetCell) });
  }
  // one pixel more on each side, so the bilinear sampler has its neighbours at the edge
  const request = (p: (typeof plan)[number], level: number) => {
    const L = p.info.levels[level];
    return { level, minX: p.box.minX - L.cellX, minY: p.box.minY - L.cellY, maxX: p.box.maxX + L.cellX, maxY: p.box.maxY + L.cellY };
  };
  const cellsAt = (levels: number[]) => plan.reduce((n, p, i) => n + cogWindowCells(p.info, request(p, levels[i])), 0);
  const chosen = plan.map((p) => p.level);
  const ownCell = (i: number, level: number) => plan[i].info.levels[level].cellX;
  let levels = chosen, stepped = false;
  const atChosen = cellsAt(chosen);
  if (atChosen > cap) {
    const ownM = provider.info.resolutionM;
    const coarser = plan.map((p, i) => coarserLevel(p.info, chosen[i]));
    if (opts.coarser === false || coarser.some((l) => l === null)) {
      throw overCapError("window-cells", `the window needs ${mCells(atChosen)} cells at ${metres(ownM)}, over the cap of ${mCells(cap)}${opts.coarser === false ? "" : "; the tiles have no coarser overview"}`);
    }
    const next = coarser as number[];
    const atNext = cellsAt(next);
    const nextM = ownM * (ownCell(0, next[0]) / ownCell(0, chosen[0]));
    if (atNext > cap) throw overCapError("window-cells", `the window needs ${mCells(atChosen)} cells at ${metres(ownM)} and ${mCells(atNext)} at ${metres(nextM)}, over the cap of ${mCells(cap)}`);
    levels = next;
    stepped = true;
  }
  let budget = cap;
  const windows: CogWindow[] = [];
  for (let i = 0; i < plan.length; i++) {
    const w = await readCogWindow(plan[i].src, plan[i].info, { ...request(plan[i], levels[i]), maxCells: budget });
    if (!w) continue;
    budget -= w.width * w.height;
    windows.push(w);
  }
  if (windows.length === 0) return "no-coverage";
  // in the provider's unit (metres) from the ratio of the cells, so a geographic CRS reads right too
  const resolutionM = stepped ? provider.info.resolutionM * (ownCell(0, levels[0]) / ownCell(0, chosen[0])) : provider.info.resolutionM;
  return { windows, tiles: tiles.length, tilesRead: windows.length, resolutionM, stepped };
}

// ---- in the worker: the paper grid ---------------------------------------------

/** The DEM on a paper-aligned grid (§7.3): cell centres at x0 + (i + ½)·cellMm, rows from the bottom; NaN = no data. */
export interface PaperGrid {
  x0: number;
  y0: number;
  cellMm: number;
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * Resample the windows onto a paper grid over the box at the model's
 * ground cell (at most 10 m, and coarser when the box would exceed 64 M
 * cells). Each cell centre goes paper → raster CRS by the exact transform
 * at lattice nodes ≤ 250 m apart and bilinearly between them, then
 * bilinearly into whichever window holds it (the first that has data).
 */
export function paperGrid(frame: mapGeo.PaperFrame, paper: PaperBox, windows: CogWindow[], demCellM: number, opts: { maxCells?: number } = {}): PaperGrid {
  const g = frame.mapScale / 1000, maxCells = opts.maxCells ?? DEM_RULES.maxPaperCells;
  const wM = (paper.maxX - paper.minX) * g, hM = (paper.maxY - paper.minY) * g;
  let cellM = Math.min(demCellM, DEM_RULES.maxPaperCellM);
  if ((wM / cellM) * (hM / cellM) > maxCells) cellM = Math.sqrt((wM * hM) / maxCells) * 1.0001;
  const size = (c: number) => [Math.max(1, Math.ceil((paper.maxX - paper.minX) / (c / g))), Math.max(1, Math.ceil((paper.maxY - paper.minY) / (c / g)))];
  while (size(cellM)[0] * size(cellM)[1] > maxCells) cellM *= 1.01;
  const cellMm = cellM / g;
  const [W, H] = size(cellM);
  const data = new Float32Array(W * H).fill(NaN);
  const byCrs = new Map<number, CogWindow[]>();
  for (const w of windows) byCrs.set(w.epsg, [...(byCrs.get(w.epsg) ?? []), w]);
  const step = Math.max(1, Math.floor(DEM_RULES.latticeM / cellM));
  const LW = Math.ceil(W / step) + 1, LH = Math.ceil(H / step) + 1;
  for (const [epsg, ws] of byCrs) {
    const f = paperToCrs(frame, epsg);
    if (!f) continue;
    // exact transform at the lattice nodes
    const lx = new Float64Array(LW * LH), ly = new Float64Array(LW * LH);
    for (let j = 0; j < LH; j++)
      for (let i = 0; i < LW; i++) {
        const p = f(paper.minX + (i * step + 0.5) * cellMm, paper.minY + (j * step + 0.5) * cellMm);
        lx[j * LW + i] = p ? p[0] : NaN;
        ly[j * LW + i] = p ? p[1] : NaN;
      }
    let last = ws[0];
    for (let y = 0; y < H; y++) {
      const j = Math.min(LH - 2, Math.floor(y / step)), ty = (y - j * step) / step;
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (!Number.isNaN(data[k])) continue; // an earlier CRS's window already holds it
        const i = Math.min(LW - 2, Math.floor(x / step)), tx = (x - i * step) / step;
        const a = j * LW + i, b = a + 1, c = a + LW, d = c + 1;
        const X = (1 - ty) * ((1 - tx) * lx[a] + tx * lx[b]) + ty * ((1 - tx) * lx[c] + tx * lx[d]);
        const Y = (1 - ty) * ((1 - tx) * ly[a] + tx * ly[b]) + ty * ((1 - tx) * ly[c] + tx * ly[d]);
        if (Number.isNaN(X) || Number.isNaN(Y)) continue;
        let v = sampleWindow(last, X, Y);
        if (Number.isNaN(v))
          for (const w of ws) {
            if (w === last) continue;
            v = sampleWindow(w, X, Y);
            if (!Number.isNaN(v)) {
              last = w;
              break;
            }
          }
        data[k] = v;
      }
    }
  }
  return { x0: paper.minX, y0: paper.minY, cellMm, width: W, height: H, data };
}

/** The anchor's and the ground field's sampler (§6.1): bilinear between the grid's cell centres, NaN-aware. */
export function paperGridSampler(grid: PaperGrid): (xMm: number, yMm: number) => number {
  const { x0, y0, cellMm, width: W, height: H, data } = grid;
  return (x, y) => {
    const fx = (x - x0) / cellMm - 0.5, fy = (y - y0) / cellMm - 0.5;
    if (!(fx >= -0.5 && fy >= -0.5 && fx <= W - 0.5 && fy <= H - 0.5)) return NaN;
    const cx = Math.max(0, Math.min(W - 1, fx)), cy = Math.max(0, Math.min(H - 1, fy));
    const i0 = Math.min(Math.floor(cx), Math.max(0, W - 2)), j0 = Math.min(Math.floor(cy), Math.max(0, H - 2));
    const i1 = Math.min(W - 1, i0 + 1), j1 = Math.min(H - 1, j0 + 1);
    const ax = cx - i0, ay = cy - j0;
    let s = 0, n = 0;
    const add = (i: number, j: number, w: number) => {
      if (w <= 0) return;
      const v = data[j * W + i];
      if (Number.isNaN(v)) return;
      s += v * w;
      n += w;
    };
    add(i0, j0, (1 - ax) * (1 - ay));
    add(i1, j0, ax * (1 - ay));
    add(i0, j1, (1 - ax) * ay);
    add(i1, j1, ax * ay);
    return n > 1e-9 ? s / n : NaN;
  };
}
