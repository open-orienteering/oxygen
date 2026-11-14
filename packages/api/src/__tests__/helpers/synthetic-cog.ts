/**
 * A synthetic cloud-optimised GeoTIFF for the DEM tests (docs/map-terrain.md
 * §7.2): the profile T2 measured on Lantmäteriet's and Copernicus's tiles —
 * classic little-endian TIFF, float32, tiled, DEFLATE with the
 * floating-point predictor, IFDs and their arrays ahead of the tile data,
 * overviews halving each level. Heights come from an analytic surface, so
 * no real DEM bytes are in the repository. Built in memory per test.
 */

import { deflateSync } from "node:zlib";

export interface SyntheticCogOptions {
  /** Height in metres at a raster-CRS position; NaN = no data. */
  surface: (x: number, y: number) => number;
  epsg: number;
  /** Full-resolution size in pixels. */
  width: number;
  height: number;
  /** Full-resolution pixel size in CRS units (y is positive: rows run south). */
  cellX: number;
  cellY: number;
  /** The tiepoint: the upper-left pixel's corner (PixelIsArea) or centre (PixelIsPoint). */
  originX: number;
  originY: number;
  /** Tile edge, pixels (default 64). */
  tile?: number;
  /** Overviews below full resolution (default 1: one at half resolution). */
  overviews?: number;
  pixelIsPoint?: boolean;
  /** GDAL_NODATA; absent = no tag (GLO-30). */
  nodata?: number;
  /** 8 = DEFLATE (default), 1 = none. */
  compression?: 1 | 8;
  /** 3 = floating point (default), 1 = none. */
  predictor?: 1 | 3;
}

const T = { SHORT: 3, LONG: 4, DOUBLE: 12, ASCII: 2 } as const;
interface Entry { tag: number; type: number; values: number[] | string }

function encodeTile(vals: Float32Array, tw: number, th: number, predictor: 1 | 3, compression: 1 | 8): Uint8Array {
  const out = new Uint8Array(tw * th * 4);
  const dv = new DataView(new ArrayBuffer(4));
  for (let y = 0; y < th; y++) {
    const row = out.subarray(y * tw * 4, (y + 1) * tw * 4);
    for (let x = 0; x < tw; x++) {
      dv.setFloat32(0, vals[y * tw + x], predictor === 1);
      if (predictor === 1) for (let b = 0; b < 4; b++) row[x * 4 + b] = dv.getUint8(b);
      // predictor 3: byte planes, most significant first, then byte-wise differencing along the row
      else for (let b = 0; b < 4; b++) row[b * tw + x] = dv.getUint8(b);
    }
    if (predictor === 3) for (let i = row.length - 1; i >= 1; i--) row[i] = (row[i] - row[i - 1]) & 0xff;
  }
  return compression === 8 ? new Uint8Array(deflateSync(out)) : out;
}

/** The pixel centre of (col, row) at a level of `fw / w` × `fh / h` coarser pixels, area convention (GDAL's for overviews). */
function centre(o: Required<Pick<SyntheticCogOptions, "cellX" | "cellY" | "originX" | "originY" | "width" | "height">> & { pixelIsPoint: boolean }, w: number, h: number, col: number, row: number): [number, number] {
  const ax = o.pixelIsPoint ? o.originX - o.cellX / 2 : o.originX, ay = o.pixelIsPoint ? o.originY + o.cellY / 2 : o.originY;
  const cx = (o.cellX * o.width) / w, cy = (o.cellY * o.height) / h;
  return [ax + (col + 0.5) * cx, ay - (row + 0.5) * cy];
}

export function buildSyntheticCog(opts: SyntheticCogOptions): Uint8Array {
  const tile = opts.tile ?? 64, levels = (opts.overviews ?? 1) + 1;
  const compression = opts.compression ?? 8, predictor = opts.predictor ?? 3, pixelIsPoint = opts.pixelIsPoint ?? false;
  const o = { ...opts, pixelIsPoint };
  const ifds: { entries: Entry[]; tiles: Uint8Array[] }[] = [];
  for (let k = 0; k < levels; k++) {
    const w = Math.ceil(opts.width / 2 ** k), h = Math.ceil(opts.height / 2 ** k);
    const across = Math.ceil(w / tile), down = Math.ceil(h / tile);
    const tiles: Uint8Array[] = [];
    for (let ty = 0; ty < down; ty++)
      for (let tx = 0; tx < across; tx++) {
        const vals = new Float32Array(tile * tile);
        for (let y = 0; y < tile; y++)
          for (let x = 0; x < tile; x++) {
            const col = tx * tile + x, row = ty * tile + y;
            if (col >= w || row >= h) continue;
            const v = opts.surface(...centre(o, w, h, col, row));
            vals[y * tile + x] = Number.isNaN(v) ? (opts.nodata ?? NaN) : v;
          }
        tiles.push(encodeTile(vals, tile, tile, predictor, compression));
      }
    const entries: Entry[] = [
      { tag: 254, type: T.LONG, values: [k === 0 ? 0 : 1] },
      { tag: 256, type: T.LONG, values: [w] },
      { tag: 257, type: T.LONG, values: [h] },
      { tag: 258, type: T.SHORT, values: [32] },
      { tag: 259, type: T.SHORT, values: [compression] },
      { tag: 262, type: T.SHORT, values: [1] },
      { tag: 277, type: T.SHORT, values: [1] },
      { tag: 284, type: T.SHORT, values: [1] },
      { tag: 317, type: T.SHORT, values: [predictor] },
      { tag: 322, type: T.SHORT, values: [tile] },
      { tag: 323, type: T.SHORT, values: [tile] },
      { tag: 324, type: T.LONG, values: tiles.map(() => 0) }, // patched below
      { tag: 325, type: T.LONG, values: tiles.map((t) => t.byteLength) },
      { tag: 339, type: T.SHORT, values: [3] },
    ];
    if (k === 0) {
      const geographic = opts.epsg === 4326;
      entries.push(
        { tag: 33550, type: T.DOUBLE, values: [opts.cellX, opts.cellY, 0] },
        { tag: 33922, type: T.DOUBLE, values: [0, 0, 0, opts.originX, opts.originY, 0] },
        { tag: 34735, type: T.SHORT, values: [1, 1, 0, 3, 1024, 0, 1, geographic ? 2 : 1, 1025, 0, 1, pixelIsPoint ? 2 : 1, geographic ? 2048 : 3072, 0, 1, opts.epsg] },
      );
      if (opts.nodata !== undefined) entries.push({ tag: 42113, type: T.ASCII, values: `${opts.nodata}\0` });
    }
    ifds.push({ entries, tiles });
  }

  const size = (e: Entry) => (typeof e.values === "string" ? e.values.length : e.values.length * (e.type === T.SHORT ? 2 : e.type === T.LONG ? 4 : 8));
  // layout: header, then each IFD followed by its out-of-line values, then every tile
  let at = 8;
  const ifdAt: number[] = [], valueAt: Map<Entry, number> = new Map();
  for (const ifd of ifds) {
    ifdAt.push(at);
    at += 2 + ifd.entries.length * 12 + 4;
    for (const e of ifd.entries)
      if (size(e) > 4) {
        valueAt.set(e, at);
        at += size(e) + (size(e) & 1);
      }
  }
  for (const ifd of ifds) {
    const offsets = ifd.entries.find((e) => e.tag === 324)!;
    offsets.values = ifd.tiles.map((t) => {
      const here = at;
      at += t.byteLength;
      return here;
    });
  }
  const out = new Uint8Array(at);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49]);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdAt[0], true);
  const put = (e: Entry, p: number) => {
    if (typeof e.values === "string") for (let i = 0; i < e.values.length; i++) out[p + i] = e.values.charCodeAt(i);
    else
      e.values.forEach((v, i) => {
        if (e.type === T.SHORT) dv.setUint16(p + i * 2, v, true);
        else if (e.type === T.LONG) dv.setUint32(p + i * 4, v, true);
        else dv.setFloat64(p + i * 8, v, true);
      });
  };
  ifds.forEach((ifd, n) => {
    let p = ifdAt[n];
    dv.setUint16(p, ifd.entries.length, true);
    p += 2;
    for (const e of ifd.entries) {
      dv.setUint16(p, e.tag, true);
      dv.setUint16(p + 2, e.type, true);
      dv.setUint32(p + 4, typeof e.values === "string" ? e.values.length : e.values.length, true);
      const v = valueAt.get(e);
      if (v === undefined) put(e, p + 8);
      else {
        dv.setUint32(p + 8, v, true);
        put(e, v);
      }
      p += 12;
    }
    dv.setUint32(p, n + 1 < ifds.length ? ifdAt[n + 1] : 0, true);
    const offsets = ifd.entries.find((e) => e.tag === 324)!.values as number[];
    ifd.tiles.forEach((bytes, i) => out.set(bytes, offsets[i]));
  });
  return out;
}

export interface FakeRangeServer {
  fetch: (url: string, init?: { headers?: Record<string, string>; method?: string; redirect?: string; signal?: AbortSignal }) => Promise<Response>;
  /** Every request: url, the Range header, the Authorization header. */
  requests: { url: string; range: string | null; authorization: string | null }[];
}

/**
 * A fetch serving `files` by URL with byte-range support (206 and
 * `Content-Range`), 404 for anything else. `ignoreRange` answers 200
 * with the whole file, as a server without range support would.
 */
export function fakeRangeServer(files: Record<string, Uint8Array | ((init: { headers: Record<string, string> }) => Response)>, opts: { ignoreRange?: boolean } = {}): FakeRangeServer {
  const requests: FakeRangeServer["requests"] = [];
  const fetch: FakeRangeServer["fetch"] = async (url, init = {}) => {
    const headers = init.headers ?? {};
    const get = (k: string) => Object.entries(headers).find(([h]) => h.toLowerCase() === k)?.[1] ?? null;
    requests.push({ url, range: get("range"), authorization: get("authorization") });
    const f = files[url];
    if (f === undefined) return new Response("not found", { status: 404 });
    if (typeof f === "function") return f({ headers });
    const range = get("range");
    const m = range && !opts.ignoreRange ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!m) return new Response(new Uint8Array(f), { status: 200, headers: { "content-length": String(f.byteLength) } });
    const a = Number(m[1]), b = Math.min(Number(m[2]), f.byteLength - 1);
    if (a >= f.byteLength) return new Response("", { status: 416 });
    return new Response(new Uint8Array(f.subarray(a, b + 1)), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${f.byteLength}`, "content-length": String(b - a + 1) } });
  };
  return { fetch, requests };
}
