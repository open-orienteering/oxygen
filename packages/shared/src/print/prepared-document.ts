/**
 * The pinned map document prepared for printing (docs/course-print.md
 * §8.2): decoded, the event's patch applied (the effective document,
 * docs/map-patches.md §2; G14), bridged to render input, with its cut
 * features, and the objects near a window. Isomorphic (§1; G13): the API's
 * print worker and, later, the browser's keep one cache per thread, keyed
 * by hash + patch version.
 */

import { decodeMapDocument } from "../map-document/codec.js";
import { type MapPatch, type PatchIssue, applyPatch } from "../map-document/patch.js";
import type { DocumentColour, MapDocumentHeader } from "../map-document/header.js";
import { type DocumentRenderInput, documentRenderInput } from "../map-document/render-bridge.js";
import { cutFeaturesOfDocument } from "../course/cuts.js";
import type { CutFeature } from "../course/types.js";
import type { MapWindow } from "../course-maps/schema.js";
import type { Bounds } from "../render/path.js";
import type { RenderObject } from "../render/symbolise.js";

/** Padding of the window crop, mm: strokes and symbols reach past their path. */
export const WINDOW_OBJECT_MARGIN_MM = 20;

/** Extent of one path, µm. `null` for an empty path. */
function pathExtent(coords: Int32Array): Bounds | null {
  if (coords.length < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < coords.length; i += 2) {
    const x = coords[i], y = coords[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Objects whose extent comes within `marginMm` of `bbox` (paper mm, y-up). */
export function objectsNear(objects: readonly RenderObject[], bbox: MapWindow, marginMm: number): RenderObject[] {
  const m = marginMm * 1000;
  const minX = bbox.minX * 1000 - m, maxX = (bbox.minX + bbox.width) * 1000 + m;
  const minY = bbox.minY * 1000 - m, maxY = (bbox.minY + bbox.height) * 1000 + m;
  return objects.filter((o) => {
    const e = pathExtent(o.path.coords);
    return !!e && e.maxX >= minX && e.minX <= maxX && e.maxY >= minY && e.minY <= maxY;
  });
}

export interface PreparedDocument {
  colours: DocumentColour[];
  input: DocumentRenderInput;
  /** The effective header (course layer context and georeferencing for the page composer, C2). */
  header: MapDocumentHeader;
  /** Point features automatic overprint cuts go around (`cutFeaturesOfDocument`, docs/course-layer.md §3.4). */
  cutFeatures: CutFeature[];
  /** Patch ops that could not be applied and were skipped (docs/map-patches.md §2.3). */
  patchIssues: PatchIssue[];
}

/**
 * The event's patch as print carries it (docs/course-print.md §8.5): the
 * `map_patches` row's content and its version, the cache key's second half.
 */
export interface PrintPatch {
  /** `map_patches.version`, a decimal string (docs/map-patches.md §3.1). */
  version: string;
  patch: MapPatch;
}

/**
 * The patch print applies to `hash`, or null when it changes nothing:
 * disabled, without ops, or keyed onto another document (docs/map-patches.md
 * §2.1, §3.3). Null prints the pinned document unchanged, byte for byte.
 */
export function livePrintPatch(hash: string, p: PrintPatch | null | undefined): PrintPatch | null {
  if (!p || !p.patch.enabled || p.patch.documentHash !== hash) return null;
  return Object.keys(p.patch.ops).length > 0 ? p : null;
}

/** The prepared cache's key: the hash alone without a live patch, else hash and patch version. */
export function preparedDocumentKey(hash: string, p: PrintPatch | null | undefined): string {
  const live = livePrintPatch(hash, p);
  return live ? `${hash}:${live.version}` : hash;
}

const prepared = new Map<string, Promise<PreparedDocument>>();
const PREPARED_MAX = 2;

/**
 * Decoded + patched + bridged document, kept for the last two keys
 * (`preparedDocumentKey`): the sheets of one print share one decode
 * through the in-flight promise. A new patch version reads and decodes
 * the document again.
 */
export function prepareDocument(
  hash: string,
  bytes: () => Promise<Uint8Array> | Uint8Array,
  patch?: PrintPatch | null,
): Promise<PreparedDocument> {
  const live = livePrintPatch(hash, patch);
  const key = preparedDocumentKey(hash, live);
  const hit = prepared.get(key);
  if (hit) {
    prepared.delete(key);
    prepared.set(key, hit);
    return hit;
  }
  const entry = (async (): Promise<PreparedDocument> => {
    const { document: doc, issues } = applyPatch(decodeMapDocument(await bytes()), live?.patch);
    return {
      colours: doc.header.colours,
      input: documentRenderInput(doc),
      header: doc.header,
      cutFeatures: cutFeaturesOfDocument(doc),
      patchIssues: issues,
    };
  })();
  prepared.set(key, entry);
  entry.catch(() => {
    if (prepared.get(key) === entry) prepared.delete(key);
  });
  while (prepared.size > PREPARED_MAX) prepared.delete(prepared.keys().next().value as string);
  return entry;
}

export function resetPreparedDocuments(): void {
  prepared.clear();
}
