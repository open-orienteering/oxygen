/**
 * JSON debug projection of a map document (docs/map-document-format.md §7):
 * the header without its section directory plus every object as nested
 * arrays. For fixtures, diffs and tooling. It is a projection, not a
 * second format — `fromJsonProjection` re-encodes to identical bytes.
 */

import type { MapDocumentHeader } from "./header.js";
import { decodeMapDocument, encodeMapDocument, type MapDocument, type MapDocumentInput, type MapObjectInput } from "./codec.js";

export interface MapObjectJson {
  symbol: number;
  type: number;
  angle?: number;
  text?: string;
  sourceIndex: number;
  /** `[x, y]` or `[x, y, flags]` per coordinate. */
  coords: number[][];
}

export interface MapDocumentJson {
  header: Omit<MapDocumentHeader, "objects" | "strings">;
  objects: MapObjectJson[];
}

export function toJsonProjection(doc: MapDocument): MapDocumentJson {
  const { objects: _o, strings: _s, ...header } = doc.header;
  void _o;
  void _s;
  const objects: MapObjectJson[] = [];
  for (let i = 0; i < doc.header.objects.count; i++) {
    const coords: number[][] = [];
    for (let k = doc.coordStart[i]; k < doc.coordStart[i + 1]; k++) {
      const f = doc.flags[k];
      coords.push(f ? [doc.coords[k * 2], doc.coords[k * 2 + 1], f] : [doc.coords[k * 2], doc.coords[k * 2 + 1]]);
    }
    const o: MapObjectJson = { symbol: doc.attrs.symbolIdx[i], type: doc.attrs.type[i], sourceIndex: doc.attrs.sourceIndex[i], coords };
    if (doc.attrs.angle[i]) o.angle = doc.attrs.angle[i];
    const text = doc.text(i);
    if (text !== undefined) o.text = text;
    objects.push(o);
  }
  return { header, objects };
}

export function fromJsonProjection(json: MapDocumentJson): Uint8Array {
  const { bounds: _b, ...header } = json.header;
  void _b;
  const objects: MapObjectInput[] = json.objects.map((o) => {
    const coords = new Int32Array(o.coords.length * 2);
    const flags = new Uint8Array(o.coords.length);
    o.coords.forEach((c, i) => {
      coords[i * 2] = c[0];
      coords[i * 2 + 1] = c[1];
      flags[i] = c[2] ?? 0;
    });
    return { symbolIdx: o.symbol, type: o.type, angleDeciDeg: o.angle, text: o.text, sourceIndex: o.sourceIndex, coords, flags };
  });
  const input: MapDocumentInput = { header, objects };
  return encodeMapDocument(input);
}

/** Convenience for tests: bytes → projection. */
export function projectBytes(bytes: Uint8Array): MapDocumentJson {
  return toJsonProjection(decodeMapDocument(bytes));
}
