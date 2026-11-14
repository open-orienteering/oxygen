/**
 * A window of a cloud-optimised GeoTIFF, read by HTTP range
 * (docs/map-terrain.md §7.2; SLICES answer 17).
 *
 * Only the profile both providers serve (T2): classic little-endian TIFF,
 * one float32 sample per pixel, tiled, uncompressed or DEFLATE, predictor
 * none or floating point, overviews as further IFDs. Anything else is a
 * `format` failure. The header is read in 64 KiB blocks (GDAL writes the
 * IFDs and their arrays first); the tiles a window needs are fetched in
 * runs of adjacent byte ranges. No request is made without `Range`, and a
 * server that ignores it is a failure: a 1 m tile is ~400 MB.
 */

import { promisify } from "node:util";
import { inflate } from "node:zlib";

const inflateAsync = promisify(inflate);

/** The fetch the reader uses; injected so tests serve a synthetic file and never open a socket. */
export type RangeFetch = (url: string, init: { headers: Record<string, string>; method?: string; redirect?: "manual" | "follow"; signal?: AbortSignal }) => Promise<Response>;

export type DemFailure = "auth" | "http" | "format" | "timeout" | "over-cap";

/** A failed DEM read; `reason` is the job's failure reason (docs/map-storage.md §4.7). Never carries a credential. */
export class DemFetchError extends Error {
  readonly reason: DemFailure;
  readonly status?: number;
  constructor(reason: DemFailure, message: string, status?: number) {
    super(message);
    this.name = "DemFetchError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

export const COG_RULES = {
  /** Header block size. */
  blockBytes: 65_536,
  /** Header bytes read before giving up on finding every IFD. */
  maxHeaderBytes: 4 * 1_048_576,
  /** One request's timeout. */
  requestTimeoutMs: 30_000,
  /** A run of adjacent tiles is fetched in one request up to this size. */
  maxRunBytes: 16 * 1_048_576,
} as const;

/** One level of the pyramid: full resolution first, then the overviews. */
export interface CogLevel {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  compression: 1 | 8;
  predictor: 1 | 3;
  offsets: number[];
  byteCounts: number[];
  /** Pixel size in CRS units, area convention. */
  cellX: number;
  cellY: number;
}

export interface CogInfo {
  url: string;
  epsg: number;
  pixelIsPoint: boolean;
  nodata: number | null;
  /** The upper-left corner of the upper-left pixel, area convention (a PixelIsPoint tiepoint moved by half a pixel). */
  originX: number;
  originY: number;
  levels: CogLevel[];
}

/** A window in a level: rows run south from `originY`, area convention. */
export interface CogWindow {
  epsg: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  cellX: number;
  cellY: number;
  /** Row-major from the north-west; NaN = no data. */
  data: Float32Array;
}

export interface CogSource {
  fetch: RangeFetch;
  url: string;
  /** Sent with every request (the provider's auth, when the host allows it). */
  headers?: Record<string, string>;
}

/** Bytes [offset, offset + length) of the source; a non-206 answer is a failure. */
export async function fetchRange(src: CogSource, offset: number, length: number): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await src.fetch(src.url, { headers: { ...src.headers, Range: `bytes=${offset}-${offset + length - 1}` }, signal: AbortSignal.timeout(COG_RULES.requestTimeoutMs) });
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new DemFetchError("timeout", `range request to ${hostOf(src.url)} timed out`);
    throw new DemFetchError("http", `range request to ${hostOf(src.url)} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new DemFetchError("auth", `${hostOf(src.url)} refused the tile (${res.status})`, res.status);
  }
  if (res.status === 416) {
    await res.body?.cancel();
    return new Uint8Array(0);
  }
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new DemFetchError("http", res.status === 200 ? `${hostOf(src.url)} does not serve range requests` : `${hostOf(src.url)} answered ${res.status}`, res.status);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > length ? buf.subarray(0, length) : buf;
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "(bad url)";
  }
};

/** Header bytes in blocks, cached. */
class HeaderReader {
  private blocks = new Map<number, Uint8Array>();
  private fetched = 0;
  private readonly src: CogSource;
  constructor(src: CogSource) {
    this.src = src;
  }

  private async block(n: number): Promise<Uint8Array> {
    let b = this.blocks.get(n);
    if (!b) {
      this.fetched += COG_RULES.blockBytes;
      if (this.fetched > COG_RULES.maxHeaderBytes) throw new DemFetchError("format", "the TIFF header is not at the start of the file (not a cloud-optimised GeoTIFF)");
      b = await fetchRange(this.src, n * COG_RULES.blockBytes, COG_RULES.blockBytes);
      this.blocks.set(n, b);
    }
    return b;
  }

  async bytes(offset: number, length: number): Promise<DataView> {
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const at = offset + done, n = Math.floor(at / COG_RULES.blockBytes), inBlock = at - n * COG_RULES.blockBytes;
      const b = await this.block(n);
      if (inBlock >= b.byteLength) throw new DemFetchError("format", "the TIFF ends inside its header");
      const take = Math.min(length - done, b.byteLength - inBlock);
      out.set(b.subarray(inBlock, inBlock + take), done);
      done += take;
    }
    return new DataView(out.buffer);
  }
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8 };

async function readTag(h: HeaderReader, entry: DataView, at: number): Promise<{ tag: number; values: number[]; text: string }> {
  const tag = entry.getUint16(at, true), type = entry.getUint16(at + 2, true), count = entry.getUint32(at + 4, true);
  const size = TYPE_SIZE[type];
  if (!size) return { tag, values: [], text: "" };
  const total = size * count;
  const view = total <= 4 ? new DataView(entry.buffer, entry.byteOffset + at + 8, 4) : await h.bytes(entry.getUint32(at + 8, true), total);
  const values: number[] = [];
  let text = "";
  for (let i = 0; i < count; i++) {
    const p = i * size;
    if (type === 1) values.push(view.getUint8(p));
    else if (type === 2) text += String.fromCharCode(view.getUint8(p));
    else if (type === 3) values.push(view.getUint16(p, true));
    else if (type === 4) values.push(view.getUint32(p, true));
    else if (type === 11) values.push(view.getFloat32(p, true));
    else if (type === 12) values.push(view.getFloat64(p, true));
    else values.push(Number(view.getBigUint64(p, true)));
  }
  return { tag, values, text };
}

/** Reads the header and every IFD; throws `DemFetchError("format")` on a profile it does not read. */
export async function readCogInfo(src: CogSource): Promise<CogInfo> {
  const h = new HeaderReader(src);
  const head = await h.bytes(0, 8);
  if (head.getUint16(0, true) !== 0x4949) throw new DemFetchError("format", "not a little-endian TIFF");
  const magic = head.getUint16(2, true);
  if (magic === 43) throw new DemFetchError("format", "BigTIFF is not read");
  if (magic !== 42) throw new DemFetchError("format", "not a TIFF");
  let next = head.getUint32(4, true);
  const ifds: Map<number, { values: number[]; text: string }>[] = [];
  const seen = new Set<number>();
  while (next !== 0) {
    if (seen.has(next) || ifds.length > 32) throw new DemFetchError("format", "the TIFF's IFD chain loops");
    seen.add(next);
    const n = (await h.bytes(next, 2)).getUint16(0, true);
    const entries = await h.bytes(next + 2, n * 12 + 4);
    const tags = new Map<number, { values: number[]; text: string }>();
    for (let i = 0; i < n; i++) {
      const t = await readTag(h, entries, i * 12);
      tags.set(t.tag, t);
    }
    ifds.push(tags);
    next = entries.getUint32(n * 12, true);
  }
  const first = ifds[0];
  if (!first) throw new DemFetchError("format", "the TIFF has no image");
  const num = (tags: Map<number, { values: number[] }>, tag: number, dflt?: number): number => {
    const v = tags.get(tag)?.values[0];
    if (v === undefined) {
      if (dflt === undefined) throw new DemFetchError("format", `the TIFF lacks tag ${tag}`);
      return dflt;
    }
    return v;
  };
  const scale = first.get(33550)?.values, tie = first.get(33922)?.values, keys = first.get(34735)?.values;
  if (!scale || !tie || tie.length < 6 || !keys) throw new DemFetchError("format", "the TIFF is not georeferenced (no pixel scale, tiepoint or geokeys)");
  const geoKey = (id: number): number | null => {
    for (let i = 4; i + 3 < keys.length; i += 4) if (keys[i] === id && keys[i + 1] === 0) return keys[i + 3];
    return null;
  };
  const epsg = geoKey(3072) ?? geoKey(2048);
  if (epsg === null) throw new DemFetchError("format", "the TIFF names no EPSG CRS");
  const pixelIsPoint = geoKey(1025) === 2;
  const nodataText = first.get(42113)?.text.replace(/\0+$/, "").trim();
  const nodata = nodataText ? Number(nodataText) : null;
  const fullW = num(first, 256), fullH = num(first, 257), cellX = scale[0], cellY = scale[1];
  const originX = tie[3] - tie[0] * cellX - (pixelIsPoint ? cellX / 2 : 0);
  const originY = tie[4] + tie[1] * cellY + (pixelIsPoint ? cellY / 2 : 0);
  const levels: CogLevel[] = [];
  for (const [i, t] of ifds.entries()) {
    const sub = num(t, 254, 0);
    if (i > 0 && (sub & 1) !== 1) continue; // a mask or another page, not an overview
    if (sub & 4) continue; // a transparency mask
    const bits = t.get(258)?.values ?? [1], format = num(t, 339, 1), spp = num(t, 277, 1);
    if (spp !== 1 || bits.some((b) => b !== 32) || format !== 3) throw new DemFetchError("format", "only single-band float32 GeoTIFFs are read");
    const compression = num(t, 259, 1), predictor = num(t, 317, 1);
    if (compression !== 1 && compression !== 8 && compression !== 32946) throw new DemFetchError("format", `TIFF compression ${compression} is not read`);
    if (predictor !== 1 && predictor !== 3) throw new DemFetchError("format", `TIFF predictor ${predictor} is not read`);
    const offsets = t.get(324)?.values, byteCounts = t.get(325)?.values;
    if (!t.has(322) || !offsets || !byteCounts) throw new DemFetchError("format", "only tiled GeoTIFFs are read");
    const w = num(t, 256), hh = num(t, 257), tw = num(t, 322), th = num(t, 323);
    if (offsets.length !== Math.ceil(w / tw) * Math.ceil(hh / th) || byteCounts.length !== offsets.length) throw new DemFetchError("format", "the TIFF's tile arrays do not match its size");
    levels.push({ width: w, height: hh, tileWidth: tw, tileHeight: th, compression: compression === 1 ? 1 : 8, predictor, offsets, byteCounts, cellX: (cellX * fullW) / w, cellY: (cellY * fullH) / hh });
  }
  return { url: src.url, epsg, pixelIsPoint, nodata, originX, originY, levels };
}

/** The coarsest level whose pixel is at most `targetCell` CRS units (the full resolution when none is). */
export function chooseLevel(info: CogInfo, targetCell: number): number {
  let best = 0;
  info.levels.forEach((l, i) => {
    if (Math.max(l.cellX, l.cellY) <= targetCell * (1 + 1e-9) && l.cellX >= info.levels[best].cellX) best = i;
  });
  return best;
}

/** Undo the floating-point predictor on one tile in place: per row, byte-wise accumulation, then big-endian byte planes → float32. */
function decodeTile(raw: Uint8Array, tw: number, th: number, predictor: 1 | 3): Float32Array {
  const out = new Float32Array(tw * th);
  if (raw.byteLength < tw * th * 4) throw new DemFetchError("format", "a TIFF tile is shorter than its size");
  if (predictor === 1) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
  }
  const rowBytes = tw * 4, tmp = new DataView(new ArrayBuffer(4));
  for (let y = 0; y < th; y++) {
    const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let i = 1; i < rowBytes; i++) row[i] = (row[i] + row[i - 1]) & 0xff;
    for (let x = 0; x < tw; x++) {
      for (let b = 0; b < 4; b++) tmp.setUint8(b, row[b * tw + x]);
      out[y * tw + x] = tmp.getFloat32(0, false);
    }
  }
  return out;
}

export interface WindowRequest {
  level: number;
  /** In the raster's CRS. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Refuse a window larger than this (`over-cap`). */
  maxCells: number;
}

/**
 * The pixels of `level` that cover the box, read tile by tile; null when
 * the box misses the raster. Pixels equal to the nodata value, and NaN,
 * are NaN.
 */
export async function readCogWindow(src: CogSource, info: CogInfo, req: WindowRequest): Promise<CogWindow | null> {
  const L = info.levels[req.level];
  if (!L) throw new RangeError(`no level ${req.level}`);
  const c0 = Math.max(0, Math.floor((req.minX - info.originX) / L.cellX)), c1 = Math.min(L.width, Math.ceil((req.maxX - info.originX) / L.cellX));
  const r0 = Math.max(0, Math.floor((info.originY - req.maxY) / L.cellY)), r1 = Math.min(L.height, Math.ceil((info.originY - req.minY) / L.cellY));
  if (c1 <= c0 || r1 <= r0) return null;
  const W = c1 - c0, H = r1 - r0;
  if (W * H > req.maxCells) throw new DemFetchError("over-cap", `a ${W} × ${H} window is over the cap of ${req.maxCells} cells`);
  const data = new Float32Array(W * H).fill(NaN);
  const across = Math.ceil(L.width / L.tileWidth);
  const tx0 = Math.floor(c0 / L.tileWidth), tx1 = Math.floor((c1 - 1) / L.tileWidth), ty0 = Math.floor(r0 / L.tileHeight), ty1 = Math.floor((r1 - 1) / L.tileHeight);
  const nodata = info.nodata;
  const place = (tx: number, ty: number, vals: Float32Array) => {
    for (let y = 0; y < L.tileHeight; y++) {
      const row = ty * L.tileHeight + y;
      if (row < r0 || row >= r1) continue;
      for (let x = 0; x < L.tileWidth; x++) {
        const col = tx * L.tileWidth + x;
        if (col < c0 || col >= c1) continue;
        const v = vals[y * L.tileWidth + x];
        data[(row - r0) * W + (col - c0)] = v === nodata ? NaN : v;
      }
    }
  };
  for (let ty = ty0; ty <= ty1; ty++) {
    // runs of tiles whose bytes are adjacent: one request each
    let tx = tx0;
    while (tx <= tx1) {
      const start = tx;
      let end = tx;
      const idx = (t: number) => ty * across + t;
      while (end + 1 <= tx1 && L.offsets[idx(end + 1)] === L.offsets[idx(end)] + L.byteCounts[idx(end)] && L.offsets[idx(end + 1)] + L.byteCounts[idx(end + 1)] - L.offsets[idx(start)] <= COG_RULES.maxRunBytes) end++;
      const from = L.offsets[idx(start)], to = L.offsets[idx(end)] + L.byteCounts[idx(end)];
      const present = L.byteCounts[idx(start)] > 0 || end > start;
      const bytes = present && to > from ? await fetchRange(src, from, to - from) : new Uint8Array(0);
      for (let t = start; t <= end; t++) {
        const n = L.byteCounts[idx(t)];
        if (n === 0) continue; // a sparse tile: no data
        const at = L.offsets[idx(t)] - from;
        if (at + n > bytes.byteLength) throw new DemFetchError("format", "a TIFF tile was cut short");
        const enc = bytes.subarray(at, at + n);
        let raw: Uint8Array;
        try {
          raw = L.compression === 8 ? new Uint8Array(await inflateAsync(enc)) : enc.slice();
        } catch {
          throw new DemFetchError("format", "a TIFF tile does not inflate");
        }
        place(t, ty, decodeTile(raw, L.tileWidth, L.tileHeight, L.predictor));
      }
      tx = end + 1;
    }
  }
  return { epsg: info.epsg, width: W, height: H, originX: info.originX + c0 * L.cellX, originY: info.originY - r0 * L.cellY, cellX: L.cellX, cellY: L.cellY, data };
}

/** Bilinear between pixel centres; NaN outside or where a neighbour is NaN and no others remain (renormalised otherwise). */
export function sampleWindow(w: CogWindow, x: number, y: number): number {
  const fx = (x - w.originX) / w.cellX - 0.5, fy = (w.originY - y) / w.cellY - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > w.width - 0.5 || fy > w.height - 0.5) return NaN;
  const cx = Math.max(0, Math.min(w.width - 1, fx)), cy = Math.max(0, Math.min(w.height - 1, fy));
  const x0 = Math.min(Math.floor(cx), Math.max(0, w.width - 2)), y0 = Math.min(Math.floor(cy), Math.max(0, w.height - 2));
  const x1 = Math.min(w.width - 1, x0 + 1), y1 = Math.min(w.height - 1, y0 + 1);
  const ax = cx - x0, ay = cy - y0;
  let s = 0, n = 0;
  const add = (xi: number, yi: number, wt: number) => {
    if (wt <= 0) return;
    const v = w.data[yi * w.width + xi];
    if (Number.isNaN(v)) return;
    s += v * wt;
    n += wt;
  };
  add(x0, y0, (1 - ax) * (1 - ay));
  add(x1, y0, ax * (1 - ay));
  add(x0, y1, (1 - ax) * ay);
  add(x1, y1, ax * ay);
  return n > 1e-9 ? s / n : NaN;
}
