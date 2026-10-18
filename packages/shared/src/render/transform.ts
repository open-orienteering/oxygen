/**
 * Structural transforms over the `RenderSymbol` IR that need no knowledge
 * of individual fields: every length key ends in `Um` (`Um2` for areas),
 * glyph geometry is a flat `coords` array, and every colour reference sits
 * under one of three keys. Used by the matcher (colour remapping after
 * alignment) and the render bridge (scaling a canonical entry by the
 * document factor, 03 §6.6).
 */

import { parseRenderSymbol, type RenderSymbol } from "./symbol.js";

const COLOUR_KEYS = new Set(["colour", "fill", "backgroundColour"]);

/** Rebuild a plain-data tree, letting `visit` replace each keyed value before recursing into it. */
function mapTree(node: unknown, visit: (key: string, value: unknown) => unknown): unknown {
  if (Array.isArray(node)) return node.map((n) => mapTree(n, visit));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = mapTree(visit(k, v), visit);
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
