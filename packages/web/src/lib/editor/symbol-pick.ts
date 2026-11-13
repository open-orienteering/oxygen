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
 */

import { mapDocument, render } from "@oxygen/shared";

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

export function pickIndexOf(doc: mapDocument.MapDocument): PickIndex {
  const { header, attrs, bboxes } = doc;
  const n = attrs.symbolIdx.length;
  const objectsPerSymbol = new Uint32Array(header.symbols.length);
  for (let i = 0; i < n; i++) if (attrs.symbolIdx[i] < objectsPerSymbol.length) objectsPerSymbol[attrs.symbolIdx[i]]++;
  const u = header.unitsPerMm;
  return {
    objectsPerSymbol,
    symbolAt(pt, toleranceMm) {
      const x = pt.x * u, y = pt.y * u, r = toleranceMm * u;
      const shapes: number[] = [];
      let text: number | null = null;
      for (let i = 0; i < n; i++) {
        if (x < bboxes[i * 4] - r || x > bboxes[i * 4 + 2] + r || y < bboxes[i * 4 + 1] - r || y > bboxes[i * 4 + 3] + r) continue;
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

/** The index of a loaded document, built on first use and kept per hash. */
export function pickIndexForDocument(hash: string, bytes: ArrayBuffer): PickIndex {
  let index = cache.get(hash);
  if (!index) {
    index = pickIndexOf(mapDocument.decodeMapDocument(new Uint8Array(bytes)));
    cache.clear();
    cache.set(hash, index);
  }
  return index;
}
