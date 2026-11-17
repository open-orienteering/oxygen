/**
 * Structural transforms over the `RenderSymbol` IR that need no knowledge
 * of individual fields: every length key ends in `Um` (`Um2` for areas),
 * glyph geometry is a flat `coords` array, and every colour reference sits
 * under one of three keys. Used by the matcher (colour remapping after
 * alignment), the render bridge (scaling a canonical entry by the document
 * factor, 03 §6.6) and colour roles (docs/map-symbols.md §9.3: each colour
 * reference by its path, so one colour used twice in a symbol is two uses).
 */

import { parseRenderSymbol, type RenderSymbol } from "./symbol.js";

const COLOUR_KEYS = new Set(["colour", "fill", "backgroundColour"]);

/** Keys and array indices from the symbol's root to a value: `["border", "borders", "left", "colour"]`, `["glyph", "parts", 2, "colour"]`. */
export type ColourPath = readonly (string | number)[];

/**
 * Rebuild a plain-data tree, letting `visit` replace each keyed value before
 * recursing into it. `path` ends with `key` and is only valid during the call.
 */
function mapTree(node: unknown, visit: (key: string, value: unknown, path: ColourPath) => unknown, path: (string | number)[] = []): unknown {
  if (Array.isArray(node)) {
    return node.map((n, i) => {
      path.push(i);
      const out = mapTree(n, visit, path);
      path.pop();
      return out;
    });
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      path.push(k);
      out[k] = mapTree(visit(k, v, path), visit, path);
      path.pop();
    }
    return out;
  }
  return node;
}

/** Multiply every length in the symbol by `factor` (areas by `factor²`, glyph coordinates included). Identity for `factor === 1`. */
export function scaleRenderSymbol(sym: RenderSymbol, factor: number): RenderSymbol {
  if (factor === 1) return sym;
  const scaled = mapTree(sym, (k, v) => {
    if (typeof v === "number") {
      if (k.endsWith("Um2")) return Math.round(v * factor * factor);
      if (k.endsWith("Um")) return Math.round(v * factor);
      return v;
    }
    // Glyph-local geometry is the only `coords` array in the IR.
    if (k === "coords" && Array.isArray(v)) return (v as number[]).map((n) => Math.round(n * factor));
    return v;
  });
  return parseRenderSymbol(scaled);
}

/** Replace every colour index through `map` (old index → new index). Throws on an index the map lacks. */
export function remapRenderColours(sym: RenderSymbol, map: ArrayLike<number>): RenderSymbol {
  const remapped = mapTree(sym, (k, v) => {
    if (COLOUR_KEYS.has(k) && typeof v === "number") {
      const n = map[v];
      if (n === undefined) throw new Error(`${sym.id}: colour index ${v} has no mapping`);
      return n;
    }
    return v;
  });
  return parseRenderSymbol(remapped);
}

/** Distinct colour indices referenced by a symbol. */
export function renderColourRefs(sym: RenderSymbol): number[] {
  const out = new Set<number>();
  mapTree(sym, (k, v) => {
    if (COLOUR_KEYS.has(k) && typeof v === "number") out.add(v);
    return v;
  });
  return [...out].sort((a, b) => a - b);
}

/** One colour reference of a symbol: where it sits and which colour index it holds. */
export interface RenderColourRef {
  path: ColourPath;
  colour: number;
}

/**
 * Every colour reference of a symbol, in tree order (the IR's key order),
 * each with its own path: a colour referenced twice is two entries
 * (docs/map-symbols.md §9.3).
 */
export function renderColourPaths(sym: RenderSymbol): RenderColourRef[] {
  const out: RenderColourRef[] = [];
  mapTree(sym, (k, v, path) => {
    if (COLOUR_KEYS.has(k) && typeof v === "number") out.push({ path: [...path], colour: v });
    return v;
  });
  return out;
}

/**
 * Replace each colour reference through `fn`, which sees its path: two
 * references of one colour may get two indices (a colour split into layers,
 * docs/map-symbols.md §9.3). `fn` returning the same index leaves it as is.
 */
export function mapRenderColourRefs(sym: RenderSymbol, fn: (ref: RenderColourRef) => number): RenderSymbol {
  const mapped = mapTree(sym, (k, v, path) => (COLOUR_KEYS.has(k) && typeof v === "number" ? fn({ path: [...path], colour: v }) : v));
  return parseRenderSymbol(mapped);
}

/**
 * Re-index per reference from a list: the k-th reference in
 * `renderColourPaths` order takes `rows[k]` (docs/map-symbols.md §9.3
 * "Layers": a colour split into rows, one row per role). Throws unless
 * there is exactly one row per reference.
 */
export function reindexRenderColours(sym: RenderSymbol, rows: ArrayLike<number>): RenderSymbol {
  const n = renderColourPaths(sym).length;
  if (n !== rows.length) throw new Error(`${sym.id}: ${n} colour references, ${rows.length} rows`);
  let k = 0;
  return mapRenderColourRefs(sym, () => rows[k++]);
}

/** Path as text, `border.borders.left.colour`, `glyph.parts[2].colour`. */
export function formatColourPath(path: ColourPath): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`)).join("");
}
