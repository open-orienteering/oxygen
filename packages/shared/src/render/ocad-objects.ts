/**
 * OCAD objects → `RenderObject`s, spike S1 step 4. **Dev-only**: the
 * `/dev/map-gl-doc?via=reader` path and the S1 measurements. Documents
 * reach the stage through `map-document/render-bridge.ts`; nothing in
 * production imports `ocadObjectsToRender`. (`ocadFlags` is the shared
 * OCAD flag mapping the importers use.)
 *
 * Until the 02 document and the 03 matcher exist, real maps enter the
 * pipeline through the fork's `readOcad` and this converter. It takes
 * the reader's objects as plain data (no dependency on `ocad2geojson`
 * here, so it stays in the shared package) and matches them to a symbol
 * list **by symbol code**: OCAD `sym` 505000 / 505001 → code "505". That
 * is enough for the pilot family (whose codes are real ISOM codes) and
 * is explicitly *not* the 03 matcher.
 *
 * Two modes:
 * - `pilot`    — objects without a matching code are dropped. What the
 *                golden rules actually cover.
 * - `envelope` — unmatched objects are mapped **by object type** to
 *                generic proxy symbols (thin line, flat fill, small
 *                disc, plain text) appended to the symbol list. Every
 *                coordinate of the document then flows through stage
 *                and GPU: an upper bound on load, not a picture of the
 *                map.
 *
 * Units: OCAD coordinates are 1/100 mm → ×10 for paper µm. Flags map
 * bit for bit onto `COORD_FLAG` (docs/map-rendering.md §2.1).
 */

import { COORD_FLAG, type RenderPath } from "./pass-stream.js";
import { type ProxyColours, proxySymbols } from "./proxy-symbols.js";
import type { RenderSymbol } from "./symbol.js";
import type { RenderObject } from "./symbolise.js";

/** The subset of the reader's `TObject` this converter reads. */
export interface OcadObjectLike {
  /** Symbol number × 1000 (+ variant). */
  sym: number;
  /** Object type: 1 point, 2 line, 3 area, 4 unformatted text, 5 formatted text, 6 line text, 7 rectangle. */
  otp: number;
  /** Rotation in 0.1°. */
  ang?: number;
  text?: string;
  /** `[x, y]` in 1/100 mm with `xFlags` / `yFlags` (low bytes of the raw int32s). */
  coordinates: ArrayLike<{ 0: number; 1: number; xFlags?: number; yFlags?: number }>;
}

export type OcadConvertMode = "pilot" | "envelope";

export interface OcadConvertOptions {
  mode?: OcadConvertMode;
  /** Colour indices the envelope proxies draw with (defaults: 0). */
  proxyColours?: ProxyColours;
}

export interface OcadConvertResult {
  objects: RenderObject[];
  /** The input list plus, in envelope mode, the proxy symbols appended. */
  symbols: RenderSymbol[];
  stats: {
    total: number;
    matched: number;
    /** Objects drawn by a proxy (envelope mode only). */
    proxied: number;
    dropped: number;
    coordinates: number;
    /** Unmatched symbol codes and how many objects use them, most used first. */
    unmatched: { code: string; count: number }[];
  };
}

export { proxySymbols } from "./proxy-symbols.js";

const OCAD_UNIT_UM = 10;

/** OCAD x/y flag bytes → `COORD_FLAG` byte. */
export function ocadFlags(xFlags: number, yFlags: number): number {
  let f = 0;
  if (xFlags & 0x01) f |= COORD_FLAG.bezierFirst;
  if (xFlags & 0x02) f |= COORD_FLAG.bezierSecond;
  if (xFlags & 0x04) f |= COORD_FLAG.noLeft;
  if (xFlags & 0x08) f |= COORD_FLAG.gap;
  if (yFlags & 0x01) f |= COORD_FLAG.corner;
  if (yFlags & 0x02) f |= COORD_FLAG.hole;
  if (yFlags & 0x04) f |= COORD_FLAG.noRight;
  if (yFlags & 0x08) f |= COORD_FLAG.dash;
  return f;
}

export function ocadSymbolCode(sym: number): string {
  return String(Math.floor(sym / 1000));
}

function pathOf(o: OcadObjectLike, closed: boolean): RenderPath | undefined {
  const n = o.coordinates.length;
  if (n === 0) return undefined;
  const coords = new Int32Array(n * 2);
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = o.coordinates[i];
    coords[2 * i] = c[0] * OCAD_UNIT_UM;
    coords[2 * i + 1] = c[1] * OCAD_UNIT_UM;
    flags[i] = ocadFlags(c.xFlags ?? 0, c.yFlags ?? 0);
  }
  return { coords, flags, closed };
}

export function ocadObjectsToRender(
  input: ArrayLike<OcadObjectLike>,
  symbols: RenderSymbol[],
  opts: OcadConvertOptions = {},
): OcadConvertResult {
  const mode = opts.mode ?? "pilot";
  const byCode = new Map<string, number>();
  symbols.forEach((s, i) => {
    if (!byCode.has(s.code)) byCode.set(s.code, i);
  });
  const allSymbols = symbols.slice();
  const proxyIdx: Partial<Record<RenderSymbol["type"], number>> = {};
  if (mode === "envelope") {
    for (const p of proxySymbols(opts.proxyColours)) {
      proxyIdx[p.type] = allSymbols.length;
      allSymbols.push(p);
    }
  }

  const objects: RenderObject[] = [];
  const unmatched = new Map<string, number>();
  let matched = 0, proxied = 0, dropped = 0, coordinates = 0;

  for (let i = 0; i < input.length; i++) {
    const o = input[i];
    const code = ocadSymbolCode(o.sym);
    const otp = o.otp;
    // Same object-type mapping as the document bridge: line text is text, a rectangle a closed line.
    const kind: RenderSymbol["type"] | undefined =
      otp === 1 ? "point" : otp === 2 || otp === 7 ? "line" : otp === 3 ? "area" : otp >= 4 && otp <= 6 ? "text" : undefined;
    let symbolIdx = byCode.get(code);
    const sym = symbolIdx === undefined ? undefined : allSymbols[symbolIdx];
    // A code match is only usable when the symbol and object kinds agree
    // (a line object on an area symbol would mis-render).
    if (sym && kind && sym.type !== kind) symbolIdx = undefined;
    let viaProxy = false;
    if (symbolIdx === undefined) {
      unmatched.set(code, (unmatched.get(code) ?? 0) + 1);
      if (mode === "envelope" && kind && proxyIdx[kind] !== undefined) {
        symbolIdx = proxyIdx[kind];
        viaProxy = true;
      } else {
        dropped++;
        continue;
      }
    }
    const path = pathOf(o, kind === "area" || otp === 7);
    if (!path || (kind === "text" && !o.text)) {
      dropped++;
      continue;
    }
    coordinates += o.coordinates.length;
    if (viaProxy) proxied++;
    else matched++;
    const obj: RenderObject = { symbolIdx, path };
    if (o.ang) obj.angleDeg = o.ang / 10;
    if (kind === "text" && o.text) {
      obj.text = o.text;
      // Same layout rule as the document bridge (map-rendering §4.9).
      if (otp === 5) obj.textLayout = "box";
      else if (otp === 6) obj.textLayout = "path";
    }
    objects.push(obj);
  }

  return {
    objects,
    symbols: allSymbols,
    stats: {
      total: input.length,
      matched,
      proxied,
      dropped,
      coordinates,
      unmatched: [...unmatched].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    },
  };
}
