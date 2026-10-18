/**
 * Map document → symboliser input (docs/map-document-format.md §8).
 *
 * Converts native units to paper µm, splits the attrs table back into
 * `RenderObject`s and resolves each object's symbol to a render IR
 * definition: the symbol's own `render` when the normaliser produced one,
 * otherwise — depending on `unmatched` — a proxy per kind (so every
 * object is drawn; the S1 "envelope") or nothing (the object is dropped).
 */

import { proxySymbols } from "../render/ocad-objects.js";
import type { RenderSymbol } from "../render/symbol.js";
import type { RenderObject } from "../render/symbolise.js";
import { scaleRenderSymbol } from "../render/transform.js";
import { getLibraryEntry } from "../symbol-library/index.js";
import { resolveEntry } from "../symbol-library/schema.js";
import { paletteIndexOfStack } from "../import/colour-align.js";
import { type DocumentSymbol, OBJECT_TYPE } from "./header.js";
import type { MapDocument } from "./codec.js";

export interface DocumentRenderOptions {
  /** What to do with objects whose symbol has no `render`: draw a proxy, or drop. Default `proxy`. */
  unmatched?: "proxy" | "drop";
  proxyColours?: { line?: number; area?: number; point?: number; text?: number };
  /** Draw objects of hidden symbols too. Default false. */
  includeHidden?: boolean;
  /**
   * Prefer the canonical library entry for symbols whose match is applied
   * (`state: "auto"` or reviewed) — 02 layer 2. Default true; `false`
   * draws every symbol from its source definition (the review UI's
   * "source" preview).
   */
  canonical?: boolean;
}

export interface DocumentRenderInput {
  objects: RenderObject[];
  /** One entry per document symbol (null-render symbols get the proxy for their kind), plus the proxies appended. */
  symbols: RenderSymbol[];
  stats: {
    total: number; rendered: number; proxied: number; hidden: number; dropped: number; coordinates: number;
    /** Symbols drawn from a canonical entry rather than their source definition. */
    canonicalSymbols: number;
    /** Applied matches whose entry or colours could not be resolved (library changed); drawn from source. */
    canonicalMissing: number;
  };
}

/** Whether a match is drawn canonically: automatic, or confirmed by review. */
export function isAppliedMatch(match: DocumentSymbol["match"]): match is NonNullable<DocumentSymbol["match"]> & { canonicalId: string } {
  return !!match && match.canonicalId !== null && (match.state === "auto" || match.reviewed);
}

/**
 * The canonical `RenderSymbol` for a matched document symbol: the library
 * entry resolved through the aligned colour stack and scaled by the
 * document factor (03 §6.6). `undefined` when the match is not applied or
 * cannot be resolved against the current library.
 */
export function canonicalRender(doc: Pick<MapDocument, "header">, sym: DocumentSymbol, index = paletteIndexOfStack(doc.header.colours)): RenderSymbol | undefined {
  if (!isAppliedMatch(sym.match)) return undefined;
  const entry = getLibraryEntry(sym.match.canonicalId);
  if (!entry) return undefined;
  try {
    return scaleRenderSymbol(resolveEntry(entry, index), doc.header.documentFactor);
  } catch {
    return undefined;
  }
}

const kindOfType = (type: number): RenderSymbol["type"] | undefined =>
  type === OBJECT_TYPE.point ? "point"
    : type === OBJECT_TYPE.line || type === OBJECT_TYPE.rectangle ? "line"
      : type === OBJECT_TYPE.area ? "area"
        : type === OBJECT_TYPE.text || type === OBJECT_TYPE.formattedText || type === OBJECT_TYPE.lineText ? "text"
          : undefined;

export function documentRenderInput(doc: MapDocument, opts: DocumentRenderOptions = {}): DocumentRenderInput {
  const unmatched = opts.unmatched ?? "proxy";
  const canonical = opts.canonical ?? true;
  const unitUm = 1000 / doc.header.unitsPerMm;
  const symbols: RenderSymbol[] = [];
  const proxyIdx: Partial<Record<RenderSymbol["type"], number>> = {};
  const proxies = proxySymbols(opts.proxyColours);
  const stats = { total: doc.header.objects.count, rendered: 0, proxied: 0, hidden: 0, dropped: 0, coordinates: 0, canonicalSymbols: 0, canonicalMissing: 0 };
  // Symbol i of the document maps to symbols[i]; placeholders keep indices aligned.
  const placeholder = proxies[0];
  const index = canonical ? paletteIndexOfStack(doc.header.colours) : undefined;
  for (const s of doc.header.symbols) {
    let render = s.render;
    if (index && isAppliedMatch(s.match)) {
      const c = canonicalRender(doc, s, index);
      if (c) { render = c; stats.canonicalSymbols++; }
      else stats.canonicalMissing++;
    }
    symbols.push(render ?? placeholder);
  }
  for (const p of proxies) {
    proxyIdx[p.type] = symbols.length;
    symbols.push(p);
  }

  const objects: RenderObject[] = [];
  for (let i = 0; i < doc.header.objects.count; i++) {
    const symIdx = doc.attrs.symbolIdx[i];
    const sym = doc.header.symbols[symIdx];
    if (!sym) {
      stats.dropped++;
      continue;
    }
    if (sym.hidden && !opts.includeHidden) {
      stats.hidden++;
      continue;
    }
    const type = doc.attrs.type[i];
    const kind = kindOfType(type);
    let renderIdx: number | undefined;
    let viaProxy = false;
    const render = symbols[symIdx];
    if ((sym.render || render !== placeholder) && (!kind || render.type === kind)) {
      renderIdx = symIdx;
    } else if (unmatched === "proxy" && kind && proxyIdx[kind] !== undefined) {
      renderIdx = proxyIdx[kind];
      viaProxy = true;
    }
    const text = doc.text(i);
    if (renderIdx === undefined || (kind === "text" && !text)) {
      stats.dropped++;
      continue;
    }
    const start = doc.coordStart[i], end = doc.coordStart[i + 1];
    const n = end - start;
    const coords = new Int32Array(n * 2);
    for (let k = 0; k < n * 2; k++) coords[k] = doc.coords[start * 2 + k] * unitUm;
    const flags = doc.flags.slice(start, end);
    const obj: RenderObject = { symbolIdx: renderIdx, path: { coords, flags, closed: kind === "area" || type === OBJECT_TYPE.rectangle } };
    const angle = doc.attrs.angle[i];
    if (angle) obj.angleDeg = angle / 10;
    if (kind === "text" && text) obj.text = text;
    objects.push(obj);
    stats.coordinates += n;
    if (viaProxy) stats.proxied++;
    else stats.rendered++;
  }
  return { objects, symbols, stats };
}
