/**
 * Colour-order parity (docs/map-rendering.md §6.5, SLICES I1): the helpers
 * of `scripts/measure-colour-order.mjs`, which draws a whole map with the
 * reference raster in two colour orders — the document's stack and a
 * *candidate* — and names every pixel that changes by the two layers on
 * top, one in each order.
 *
 * Naming reads a second raster per order, the *paint* image: the same pass
 * stream with every (stack row, pass kind, symbol) drawn in its own colour
 * and without anti-aliasing, so each pixel says which paint is on top.
 * That stays exact where several rows share one ink (a colour serving two
 * roles), which naming by the visible colour cannot.
 *
 * Everything here is pure except `rasterisePaints` (resvg). The script does
 * the import, the tile loop, the files and the printing.
 */

import { z } from "zod";
import { mapDocument, mapImport, render, symbolLibrary } from "@oxygen/shared";

type MapDocument = mapDocument.MapDocument;

// ---------------------------------------------------------------- images

export interface Rgba {
  width: number;
  height: number;
  /** RGBA, row-major, top row first. */
  pixels: Uint8Array;
}

/** The default channel tolerance: the golden tier's (§6.2). The 2026-11-14 experiment used 24. */
export const DEFAULT_TOLERANCE = 16;

/**
 * Pixels whose largest RGB channel difference exceeds `tolerance` (1 in
 * `mask`), how many, and how many are inked (not white) in `a`.
 */
export function changedMask(a: Rgba, b: Rgba, tolerance = DEFAULT_TOLERANCE): { mask: Uint8Array; changed: number; inked: number } {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`image size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const n = a.width * a.height;
  const mask = new Uint8Array(n);
  const p = a.pixels, q = b.pixels;
  let changed = 0, inked = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (p[o] !== 255 || p[o + 1] !== 255 || p[o + 2] !== 255) inked++;
    const d = Math.max(Math.abs(p[o] - q[o]), Math.abs(p[o + 1] - q[o + 1]), Math.abs(p[o + 2] - q[o + 2]));
    if (d > tolerance) {
      mask[i] = 1;
      changed++;
    }
  }
  return { mask, changed, inked };
}

/** Source | candidate | difference (red where changed, the source at a quarter of its contrast elsewhere), `gap` white pixels apart. */
export function sideBySide(a: Rgba, b: Rgba, mask: Uint8Array, gap = 8): Rgba {
  if (a.width !== b.width || a.height !== b.height || mask.length !== a.width * a.height) throw new Error("sideBySide: size mismatch");
  const w = a.width, h = a.height, W = w * 3 + gap * 2;
  const out = new Uint8Array(W * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      const put = (col: number, r: number, g: number, bl: number) => {
        const t = (y * W + col * (w + gap) + x) * 4;
        out[t] = r; out[t + 1] = g; out[t + 2] = bl;
      };
      put(0, a.pixels[o], a.pixels[o + 1], a.pixels[o + 2]);
      put(1, b.pixels[o], b.pixels[o + 1], b.pixels[o + 2]);
      if (mask[i]) put(2, 255, 0, 0);
      else {
        const grey = 255 - Math.round((255 - (a.pixels[o] + a.pixels[o + 1] + a.pixels[o + 2]) / 3) * 0.25);
        put(2, grey, grey, grey);
      }
    }
  }
  return { width: W, height: h, pixels: out };
}

// ---------------------------------------------------------------- tiles

export interface Tile {
  x: number;
  y: number;
  /** Paper µm, y-up. */
  bounds: render.Bounds;
}

/**
 * Square tiles of `tileMm` over `bounds` (paper µm), row 0 at the bottom;
 * with `window`, only the tiles that meet it.
 */
export function tileGrid(bounds: render.Bounds, tileMm: number, window?: render.Bounds): { nx: number; ny: number; tiles: Tile[] } {
  if (!(tileMm > 0)) throw new Error("tileGrid: tile size must be positive");
  const t = tileMm * 1000;
  const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / t));
  const ny = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / t));
  const tiles: Tile[] = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const b = { minX: bounds.minX + x * t, minY: bounds.minY + y * t, maxX: bounds.minX + (x + 1) * t, maxY: bounds.minY + (y + 1) * t };
      if (window && (b.maxX <= window.minX || b.minX >= window.maxX || b.maxY <= window.minY || b.minY >= window.maxY)) continue;
      tiles.push({ x, y, bounds: b });
    }
  }
  return { nx, ny, tiles };
}

/** The `n` tiles with the most changed pixels (none with zero); ties by row, then column. */
export function rankTiles<T extends { x: number; y: number; changed: number }>(tiles: readonly T[], n: number): T[] {
  return tiles
    .filter((t) => t.changed > 0)
    .sort((a, b) => b.changed - a.changed || a.y - b.y || a.x - b.x)
    .slice(0, Math.max(0, n));
}

// ---------------------------------------------------------------- paints

/** What draws a pixel: one stack row, one pass kind, one symbol. */
export interface Paint {
  row: number;
  kind: render.PassKind;
  symbolIdx: number;
}

/**
 * A copy of `stream` whose passes carry a dense *paint id* in `colour`, one
 * per (row, kind, symbol). Ids rise with the stream's canonical sort key,
 * so `passStreamToSvg`'s sort keeps the painter's order exactly.
 */
export function paintStream(stream: render.PassStream): { stream: render.PassStream; paints: Paint[] } {
  const s = render.sortPassStream(stream);
  const paints: Paint[] = [];
  const ids = new Map<string, number>();
  const passes = s.passes.map((p, i) => {
    const key = `${p.colour}/${p.kind}/${s.symbolIdx[i]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = paints.length;
      ids.set(key, id);
      paints.push({ row: p.colour, kind: p.kind, symbolIdx: s.symbolIdx[i] });
    }
    return { ...p, colour: id } as render.Pass;
  });
  return { stream: { ...s, passes }, paints };
}

/** Paint id → its colour in a paint image: `id + 1` as 24-bit RGB (black, 0, is nothing drawn). */
export function idHex(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id >= 0xffffff) throw new Error(`paint id ${id} out of range`);
  return `#${(id + 1).toString(16).padStart(6, "0")}`;
}

/** Nothing drawn at a pixel, and a value that is no paint (a blended edge). */
export const NOTHING = -1;
export const UNDECODABLE = -2;

/** Per pixel the paint id on top, `NOTHING` or `UNDECODABLE`. */
export function decodePaints(img: Rgba, paints: number): Int32Array {
  const n = img.width * img.height;
  const out = new Int32Array(n);
  const p = img.pixels;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const v = (p[o] << 16) | (p[o + 1] << 8) | p[o + 2];
    out[i] = p[o + 3] !== 255 ? UNDECODABLE : v === 0 ? NOTHING : v <= paints ? v - 1 : UNDECODABLE;
  }
  return out;
}

/**
 * The paint image of a stream: the reference raster's SVG (§5.1) with paint
 * colours on black, rasterised by resvg with crisp edges.
 */
export async function rasterisePaints(
  stream: render.PassStream,
  opts: { bounds: render.Bounds; pxPerMm: number; glyphOutline?: render.ReferenceSvgOptions["glyphOutline"] },
): Promise<{ width: number; height: number; ids: Int32Array; paints: Paint[] }> {
  const { stream: painted, paints } = paintStream(stream);
  const svg = render
    .passStreamToSvg(painted, { colour: idHex, bounds: opts.bounds, marginUm: 0, pxPerMm: opts.pxPerMm, background: "#000000", glyphOutline: opts.glyphOutline })
    .replace("<svg ", '<svg shape-rendering="crispEdges" ');
  const { renderAsync } = await import("@resvg/resvg-js");
  const r = await renderAsync(svg, { fitTo: { mode: "original" } });
  const img = { width: r.width, height: r.height, pixels: new Uint8Array(r.pixels.buffer, r.pixels.byteOffset, r.pixels.byteLength) };
  return { width: r.width, height: r.height, ids: decodePaints(img, paints.length), paints };
}

// ---------------------------------------------------------------- naming

/** Names for the kinds a pixel can fall into besides two layers. */
export const UNATTRIBUTED = "(unattributed)";
export const NOTHING_NAME = "(paper)";

/** The key of a change kind: the layer on top in the source drawing, then in the candidate. */
export const kindKey = (from: string, to: string): string => `${from} → ${to}`;
export function splitKind(key: string): [string, string] {
  const at = key.indexOf(" → ");
  return at < 0 ? [key, key] : [key.slice(0, at), key.slice(at + 3)];
}

/** A pair of paint images (source, candidate) and how to name their paints. */
export interface PaintView {
  source: Int32Array;
  candidate: Int32Array;
  nameSource: (paint: number) => string;
  nameCandidate: (paint: number) => string;
}

/**
 * The two layers a view has on top at pixel `i`, or null when it cannot
 * tell the change apart: the same layer on top in both orders, or a value
 * that is no paint.
 */
export function viewKind(v: PaintView, i: number): { from: string; to: string } | null {
  const a = v.source[i], b = v.candidate[i];
  if (a === UNDECODABLE || b === UNDECODABLE) return null;
  const from = a === NOTHING ? NOTHING_NAME : v.nameSource(a);
  const to = b === NOTHING ? NOTHING_NAME : v.nameCandidate(b);
  return from === to ? null : { from, to };
}

/**
 * The kind of a pixel the top layers cannot tell (the same layer on top in
 * both orders, or nothing drawn at its centre): an anti-aliased pixel takes
 * colour from the layers around it, so among the layers on top anywhere in
 * its 3×3 neighbourhood (both images) it is the pair whose order differs
 * between the two stacks — named by the one above in the source, then the
 * one above in the candidate. Several flipped pairs: the one seen most
 * often around the pixel, ties by key. `rowOf` gives a paint name's place
 * in each stack (`graphic:` stripped); undefined when no pair flipped.
 */
export function flipKind(
  v: PaintView,
  i: number,
  width: number,
  height: number,
  rowOf: { source: (name: string) => number | undefined; candidate: (name: string) => number | undefined },
): string | undefined {
  const x = i % width, y = (i - x) / width;
  const seen = new Map<string, number>();
  const add = (id: number, name: (p: number) => string) => {
    if (id < 0) return;
    const n = name(id);
    seen.set(n, (seen.get(n) ?? 0) + 1);
  };
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const j = yy * width + xx;
      add(v.source[j], v.nameSource);
      add(v.candidate[j], v.nameCandidate);
    }
  }
  const names = [...seen.keys()].sort();
  let best: { key: string; score: number } | undefined;
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      const p = names[a], q = names[b];
      const sp = rowOf.source(p), sq = rowOf.source(q), cp = rowOf.candidate(p), cq = rowOf.candidate(q);
      if (sp === undefined || sq === undefined || cp === undefined || cq === undefined || sp === sq || cp === cq) continue;
      if (sp > sq === cp > cq) continue;
      const key = sp > sq ? kindKey(p, q) : kindKey(q, p);
      const score = seen.get(p)! + seen.get(q)!;
      if (!best || score > best.score || (score === best.score && key < best.key)) best = { key, score };
    }
  }
  return best?.key;
}

/** A pixel's kind from one paint view: `viewKind`, else `flipKind`; undefined when neither can tell. */
export function viewKindOf(
  v: PaintView,
  width: number,
  height: number,
  rowOf: Parameters<typeof flipKind>[4],
): (i: number) => string | undefined {
  return (i) => {
    const k = viewKind(v, i);
    return k ? kindKey(k.from, k.to) : flipKind(v, i, width, height, rowOf);
  };
}

/**
 * Names every changed pixel by its kind `"<from> → <to>"`. `kindOf(i)`
 * gives a pixel's kind when the paint images can tell it (`viewKind`, then
 * `flipKind`); a pixel they cannot takes the most frequent kind among its
 * changed 8-neighbours that have one (ties: the first in key order), else
 * `(unattributed)`. Counts sum to the changed pixels.
 */
export function nameChanges(mask: Uint8Array, width: number, height: number, kindOf: (i: number) => string | undefined): Map<string, number> {
  const n = width * height;
  if (mask.length !== n) throw new Error("nameChanges: size mismatch");
  const kinds = new Map<string, number>();
  const kindAt = new Array<string | undefined>(n);
  const fringe: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const k = kindOf(i);
    if (k === undefined) {
      fringe.push(i);
      continue;
    }
    kindAt[i] = k;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  for (const i of fringe) {
    const x = i % width, y = (i - x) / width;
    const votes = new Map<string, number>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((dx || dy) && xx >= 0 && yy >= 0 && xx < width && yy < height) {
          const k = kindAt[yy * width + xx];
          if (k) votes.set(k, (votes.get(k) ?? 0) + 1);
        }
      }
    }
    const best = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? UNATTRIBUTED;
    kinds.set(best, (kinds.get(best) ?? 0) + 1);
  }
  return kinds;
}

/** The stream without the passes drawn in `rows`: a paint image with those layers peeled off. */
export function withoutRows(stream: render.PassStream, rows: ReadonlySet<number>): render.PassStream {
  const keep: number[] = [];
  stream.passes.forEach((p, i) => {
    if (!rows.has(p.colour)) keep.push(i);
  });
  return {
    ...stream,
    passes: keep.map((i) => stream.passes[i]),
    objectIdx: Uint32Array.from(keep, (i) => stream.objectIdx[i]),
    symbolIdx: Uint32Array.from(keep, (i) => stream.symbolIdx[i]),
    ...(stream.maskIdx ? { maskIdx: Int32Array.from(keep, (i) => stream.maskIdx![i]) } : {}),
  };
}

/**
 * The layer both orders have on top at `i`, the one to peel off when a
 * view cannot tell the change: null for the paper, a blended value, or two
 * different layers. `graphic:` is stripped (peeling removes the row).
 */
export function sharedTop(v: PaintView, i: number): string | null {
  const a = v.source[i], b = v.candidate[i];
  if (a < 0 || b < 0) return null;
  const strip = (n: string) => (n.startsWith(GRAPHIC_PREFIX) ? n.slice(GRAPHIC_PREFIX.length) : n);
  const from = strip(v.nameSource(a));
  return from === strip(v.nameCandidate(b)) ? from : null;
}

// ---------------------------------------------------------------- layers

/** A row of a colour stack as the harness names it. */
export interface StackLayer {
  /** Index in its stack (= draw order). */
  row: number;
  /** Palette ids of the alignment palette this row stands for, bottom first; empty: no role. */
  roles: string[];
  /** Objects drawn in it (a symbol's objects count once per colour it references). */
  uses: number;
  /** The symbol kind drawing most of those objects; `none` when unused. */
  kind: string;
  /** Its colour class (`hue` and percent, e.g. `white`, `brown50`), `unclassified` when §9.1 gives none. */
  colourClass: string;
  /** Unique in its stack: the roles joined by `+`, else `none:<colourClass>:<kind>`; repeats get `#2`, `#3`… in stack order. */
  name: string;
}

/** Objects per document symbol. */
export function objectsPerSymbol(doc: Pick<MapDocument, "header" | "attrs">): number[] {
  const n = new Array<number>(doc.header.symbols.length).fill(0);
  for (let i = 0; i < doc.header.objects.count; i++) n[doc.attrs.symbolIdx[i]]++;
  return n;
}

/** The alignment palette (`map-symbols.md` §9.2) as id → position, bottom first. */
export function paletteRank(edition: symbolLibrary.PaletteEdition, spec: symbolLibrary.SpecId): Map<string, number> {
  const rows = mapImport.alignmentPalette(edition, spec).slice().reverse();
  return new Map(rows.map((e, i) => [e.id, i]));
}

const colourClassName = (c: mapImport.ColourClass | null): string =>
  !c ? "unclassified" : c.percent === 100 ? c.hue : `${c.hue}${Math.round(c.percent)}`;

/**
 * The layers of a stack. `symbols` are the render symbols the document is
 * drawn with (`documentRenderInput(doc).symbols`, canonical ones resolved
 * into this stack), `perSymbol` the objects per document symbol,
 * `identified` the palette id stage 7 identified per row (§9.2 step 2).
 */
export function stackLayers(
  colours: readonly mapDocument.DocumentColour[],
  docSymbols: readonly Pick<mapDocument.DocumentSymbol, "kind" | "hidden">[],
  symbols: readonly (render.RenderSymbol | null | undefined)[],
  perSymbol: readonly number[],
  identified: readonly (string | undefined)[],
  rank: ReadonlyMap<string, number>,
): StackLayer[] {
  const kinds = colours.map(() => new Map<string, number>());
  const uses = colours.map(() => 0);
  docSymbols.forEach((s, i) => {
    const n = perSymbol[i] ?? 0;
    const r = symbols[i];
    if (!n || s.hidden || !r) return;
    for (const c of render.renderColourRefs(r)) {
      if (c < 0 || c >= colours.length) continue;
      uses[c] += n;
      kinds[c].set(s.kind, (kinds[c].get(s.kind) ?? 0) + n);
    }
  });
  const layers = colours.map((c, row): StackLayer => {
    const ids = new Set([...(c.paletteIds ?? []), ...(identified[row] ? [identified[row]!] : [])]);
    const roles = [...ids].filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
    const kind = [...kinds[row]].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "none";
    return { row, roles, uses: uses[row], kind, colourClass: colourClassName(mapImport.classifyColour(c).class), name: "" };
  });
  return nameLayers(layers);
}

/** Sets each layer's unique `name` (see `StackLayer.name`). */
export function nameLayers<T extends Pick<StackLayer, "roles" | "kind" | "colourClass" | "name">>(layers: T[]): T[] {
  const seen = new Map<string, number>();
  for (const l of layers) {
    const base = l.roles.length ? l.roles.join("+") : `none:${l.colourClass}:${l.kind}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    l.name = n === 1 ? base : `${base}#${n}`;
  }
  return layers;
}

/** The prefix of a paint drawn by a graphic object's synthesised symbol (`origin: "graphic"`). */
export const GRAPHIC_PREFIX = "graphic:";

/** A paint's name: its layer's, prefixed `graphic:` when a graphic object's symbol draws it. */
export function paintNamer(
  paints: readonly Paint[],
  layers: readonly Pick<StackLayer, "name">[],
  docSymbols: readonly Pick<mapDocument.DocumentSymbol, "origin">[],
): (paint: number) => string {
  return (id) => {
    const p = paints[id];
    const layer = layers[p.row]?.name ?? `row${p.row}`;
    return docSymbols[p.symbolIdx]?.origin === "graphic" ? GRAPHIC_PREFIX + layer : layer;
  };
}

// ---------------------------------------------------------------- the candidate

/**
 * The 2026-11-14 experiment's candidate order, a permutation of the stack:
 * each row at its highest role's palette position; a row with no role by
 * the kind that draws most in it — an area colour at the top of the area
 * block (just under lower purple), anything else just under upper purple.
 * Ties keep the stack order. Returns new row → old row.
 */
export function permutationOrder(layers: readonly Pick<StackLayer, "row" | "roles" | "kind">[], rank: ReadonlyMap<string, number>): number[] {
  const lower = rank.get("purple-lower");
  const upper = rank.get("purple-upper");
  if (lower === undefined || upper === undefined) throw new Error("palette without lower and upper purple");
  const key = (l: Pick<StackLayer, "roles" | "kind">): number =>
    l.roles.length ? Math.max(...l.roles.map((id) => rank.get(id)!)) : l.kind === "area" ? lower - 0.5 : upper - 0.5;
  return layers.map((l) => ({ row: l.row, k: key(l) })).sort((a, b) => a.k - b.k || a.row - b.row).map((x) => x.row);
}

/** old row → new row for a `new → old` order; throws unless it is a permutation. */
export function inverseOrder(order: readonly number[]): number[] {
  const inv = new Array<number>(order.length).fill(-1);
  order.forEach((old, n) => {
    if (!Number.isInteger(old) || old < 0 || old >= order.length || inv[old] !== -1) throw new Error(`not a permutation at ${n}`);
    inv[old] = n;
  });
  return inv;
}

/**
 * The document with its stack permuted (`order`: new row → old row) and
 * every source symbol's IR re-indexed. Canonical symbols follow by their
 * palette ids (the render bridge resolves them through the stack).
 */
export function permuteStack<D extends Pick<MapDocument, "header">>(doc: D, order: readonly number[]): D {
  const remap = inverseOrder(order);
  const h = doc.header;
  return {
    ...doc,
    header: {
      ...h,
      colours: order.map((i) => h.colours[i]),
      symbols: h.symbols.map((s) => (s.render ? { ...s, render: render.remapRenderColours(s.render, remap) } : s)),
    },
  };
}

// ---------------------------------------------------------------- census

export interface ColourCensus {
  objects: number;
  colours: number;
  /** Rows that objects draw in. */
  used: number;
  /** Used rows without a palette entry, and the objects drawn in them. */
  unidentified: number;
  uses: number;
  unidentifiedUses: number;
  /** Used rows that stand for several palette ids. */
  multi: { row: number; roles: string[]; uses: number }[];
  /** Symbols with objects, by match state (`none`: no match record); `graphic`: synthesised for graphic objects. */
  symbols: { used: number; auto: number; suggested: number; unmatched: number; none: number; reviewed: number; graphic: number };
  /** Rows of the two course purples; -1 when absent. */
  lowerAt: number;
  upperAt: number;
}

export function colourCensus(doc: Pick<MapDocument, "header">, layers: readonly StackLayer[], perSymbol: readonly number[]): ColourCensus {
  const used = layers.filter((l) => l.uses > 0);
  const none = used.filter((l) => l.roles.length === 0);
  const sum = (ls: readonly StackLayer[]) => ls.reduce((t, l) => t + l.uses, 0);
  const symbols = { used: 0, auto: 0, suggested: 0, unmatched: 0, none: 0, reviewed: 0, graphic: 0 };
  doc.header.symbols.forEach((s, i) => {
    if (!perSymbol[i]) return;
    symbols.used++;
    if (s.origin === "graphic") symbols.graphic++;
    if (!s.match) symbols.none++;
    else {
      symbols[s.match.state]++;
      if (s.match.reviewed) symbols.reviewed++;
    }
  });
  const colours = doc.header.colours;
  return {
    objects: doc.header.objects.count,
    colours: colours.length,
    used: used.length,
    unidentified: none.length,
    uses: sum(used),
    unidentifiedUses: sum(none),
    multi: used.filter((l) => l.roles.length > 1).map((l) => ({ row: l.row, roles: l.roles, uses: l.uses })),
    symbols,
    lowerAt: colours.findIndex((c) => c.purpleRole === "lower"),
    upperAt: colours.findIndex((c) => c.purpleRole === "upper"),
  };
}

// ---------------------------------------------------------------- classification

/** What a change is (SLICES I1): every remaining difference must be one of these. */
export const CHANGE_CLASSES = ["multi-role", "mask", "layout", "deviation-kept", "deviation-dropped", "no-role"] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];
export const UNCLASSIFIED = "unclassified";

const ruleSchema = z.object({
  /** A map label; absent: every map. */
  map: z.string().min(1).optional(),
  /** Layer names (as printed), or `*`. Directional: the source's on top, then the candidate's. */
  from: z.string().min(1),
  to: z.string().min(1),
  class: z.enum(CHANGE_CLASSES),
  note: z.string().optional(),
});
const classificationSchema = z.object({ version: z.literal(1), rules: z.array(ruleSchema) });
export type ClassRule = z.output<typeof ruleSchema>;
export type Classification = z.output<typeof classificationSchema>;

/** Reads a classification file's JSON; throws naming the first bad rule. */
export function parseClassification(json: unknown): Classification {
  const r = classificationSchema.safeParse(json);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const at = issue.path[0] === "rules" && typeof issue.path[1] === "number" ? `rule ${issue.path[1]}` : issue.path.join(".") || "file";
  throw new Error(`classification: ${at}: ${issue.message}`);
}

export interface ClassifiedKind {
  from: string;
  to: string;
  px: number;
  class: ChangeClass | typeof UNCLASSIFIED;
  /** Index of the rule that classified it. */
  rule?: number;
}

export interface ClassificationResult {
  /** Most pixels first. */
  kinds: ClassifiedKind[];
  byClass: Record<ChangeClass | typeof UNCLASSIFIED, number>;
  changed: number;
  unclassified: number;
  /** unclassified ÷ changed; 0 when nothing changed. */
  unclassifiedShare: number;
  /** Rules for this map (or every map) that classified nothing: stale or mistyped. */
  unusedRules: number[];
}

/**
 * Classifies a map's change kinds: the first rule (file order) whose map,
 * `from` and `to` match. `(unattributed)` is never classified, so the gate
 * cannot pass by leaving pixels unnamed.
 */
export function classify(kinds: ReadonlyMap<string, number>, c: Classification, mapLabel: string): ClassificationResult {
  const byClass = Object.fromEntries([...CHANGE_CLASSES, UNCLASSIFIED].map((k) => [k, 0])) as ClassificationResult["byClass"];
  const used = new Set<number>();
  const out: ClassifiedKind[] = [];
  let changed = 0;
  for (const [key, px] of [...kinds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    const [from, to] = splitKind(key);
    changed += px;
    const rule = from === UNATTRIBUTED || to === UNATTRIBUTED
      ? -1
      : c.rules.findIndex((r) => (r.map === undefined || r.map === mapLabel) && (r.from === "*" || r.from === from) && (r.to === "*" || r.to === to));
    const cls = rule < 0 ? UNCLASSIFIED : c.rules[rule].class;
    if (rule >= 0) used.add(rule);
    byClass[cls] += px;
    out.push({ from, to, px, class: cls, ...(rule >= 0 ? { rule } : {}) });
  }
  const unclassified = byClass[UNCLASSIFIED];
  const unusedRules = c.rules.flatMap((r, i) => (!used.has(i) && (r.map === undefined || r.map === mapLabel) ? [i] : []));
  return { kinds: out, byClass, changed, unclassified, unclassifiedShare: changed ? unclassified / changed : 0, unusedRules };
}

/** What `suggestClass` needs of a layer, looked up by its printed name (without `graphic:`). */
export type LayerOf = (name: string) => Pick<StackLayer, "roles" | "colourClass"> | undefined;

/**
 * A *hint* for a change kind, never counted: `layout` when a graphic
 * object's paint is involved; `multi-role` when either layer stands for
 * several palette ids; `mask` for a white without a role; `no-role` for any
 * other layer without one; `deviation-dropped` when both have one role and
 * the palette puts the candidate's layer above the source's (the candidate
 * restored the palette's order against the source's). Else null.
 */
export function suggestClass(from: string, to: string, layerOf: LayerOf, rank: ReadonlyMap<string, number>): ChangeClass | null {
  if (from.startsWith(GRAPHIC_PREFIX) || to.startsWith(GRAPHIC_PREFIX)) return "layout";
  const a = layerOf(from), b = layerOf(to);
  if (!a || !b) return null;
  if (a.roles.length > 1 || b.roles.length > 1) return "multi-role";
  const maskish = (l: NonNullable<ReturnType<LayerOf>>) => l.roles.length === 0 && l.colourClass.startsWith("white");
  if (maskish(a) || maskish(b)) return "mask";
  if (a.roles.length === 0 || b.roles.length === 0) return "no-role";
  return rank.get(b.roles[0])! > rank.get(a.roles[0])! ? "deviation-dropped" : null;
}
