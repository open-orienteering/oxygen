/**
 * The filter region's eyedropper (docs/course-editor.md §6.4): which map
 * symbol is under a click. On the main thread like snapping (`snap.ts`):
 * the document is already decoded here, and a click must not wait a
 * worker round trip.
 *
 * The objects whose stored box (grown by the tolerance) holds the point are
 * symbolised with the shared stage (`documentRenderInput { only }`,
 * `render.symbolise`) and hit-tested on their drawn shape
 * (`render.hitTest`, map-rendering §5.5): the topmost hit within the
 * tolerance wins — what is drawn on top near the click, so a path over an
 * open-land area is picked beside it, the area away from it. Hidden symbols
 * are not drawn and never picked. Texts are picked by their stored box
 * (the main thread has no fonts) and count as on top.
 *
 * The index is of the effective document (docs/map-patches.md §2.4):
 * objects the patch hides are neither picked nor counted, modified ones are
 * picked where they now are, added ones of a document symbol are picked and
 * counted. An object drawn with a patch symbol is not picked by symbol — a
 * filter region stores document symbol indices (map-rendering §4.11) and a
 * patch symbol's index moves with the patch (map-patches §2.2) — so a click
 * on it picks what is under it.
 */

import { mapDocument, render } from "@oxygen/shared";
import type { MapPatchDelivery } from "../map-document-cache";

type Pt = { x: number; y: number };

export interface SymbolPick {
  /** Document symbol index. */
  symbolIdx: number;
  /** Document colour of the pass under the click (the colours mode); null for a text. */
  colour: number | null;
}

export interface PickIndex {
  /** Objects per document symbol. */
  objectsPerSymbol: Uint32Array;
  /** The symbol drawn topmost at `pt` (paper mm) within `toleranceMm`, or null. */
  symbolAt(pt: Pt, toleranceMm: number): SymbolPick | null;
}

const TEXT_TYPES = new Set<number>([mapDocument.OBJECT_TYPE.text, mapDocument.OBJECT_TYPE.formattedText, mapDocument.OBJECT_TYPE.lineText]);

export function pickIndexOf(doc: mapDocument.EffectiveDocument): PickIndex {
  const { header, attrs, bboxes, hidden } = doc;
  const n = attrs.symbolIdx.length;
  /** Document symbols only: a patch symbol (index ≥ this) is not pickable. */
  const symbolCount = doc.patch?.baseSymbols ?? header.symbols.length;
  const pickable = (i: number) => !hidden?.[i] && attrs.symbolIdx[i] < symbolCount;
  const objectsPerSymbol = new Uint32Array(symbolCount);
  for (let i = 0; i < n; i++) if (pickable(i)) objectsPerSymbol[attrs.symbolIdx[i]]++;
  const u = header.unitsPerMm;
  return {
    objectsPerSymbol,
    symbolAt(pt, toleranceMm) {
      const x = pt.x * u, y = pt.y * u, r = toleranceMm * u;
      const shapes: number[] = [];
      let text: number | null = null;
      for (let i = 0; i < n; i++) {
        if (x < bboxes[i * 4] - r || x > bboxes[i * 4 + 2] + r || y < bboxes[i * 4 + 1] - r || y > bboxes[i * 4 + 3] + r) continue;
        if (!pickable(i)) continue;
        if (header.symbols[attrs.symbolIdx[i]]?.hidden) continue;
        if (TEXT_TYPES.has(attrs.type[i])) text = i;
        else shapes.push(i);
      }
      if (text !== null) return { symbolIdx: attrs.symbolIdx[text], colour: null };
      if (shapes.length === 0) return null;
      const input = mapDocument.documentRenderInput(doc, { only: shapes });
      const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts: [] });
      const [top] = render.hitTest(stream, pt.x * 1000, pt.y * 1000, { toleranceUm: toleranceMm * 1000 });
      if (!top) return null;
      const pass = stream.passes[top.passIdx];
      return {
        symbolIdx: attrs.symbolIdx[input.docIdx[top.objectIdx]],
        colour: pass.colour < header.colours.length ? pass.colour : null,
      };
    },
  };
}

const cache = new Map<string, PickIndex>();

/**
 * The index of a loaded document with the event's patch (`useMapPatch`), built on first use and
 * kept per hash and patch version. A patch keyed onto another document is not applied.
 */
export function pickIndexForDocument(hash: string, bytes: ArrayBuffer, patch?: MapPatchDelivery | null): PickIndex {
  const p = patch?.patch && patch.patch.documentHash === hash ? patch : null;
  const key = `${hash}:${p ? p.version : "0"}`;
  let index = cache.get(key);
  if (!index) {
    const doc = mapDocument.decodeMapDocument(new Uint8Array(bytes));
    index = pickIndexOf(mapDocument.applyPatch(doc, p?.patch).document);
    cache.clear();
    cache.set(key, index);
  }
  return index;
}
