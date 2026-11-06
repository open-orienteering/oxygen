/**
 * The pinned map document prepared for printing (docs/course-print.md
 * §8.2): decoded, bridged to render input, with its cut features, and
 * the objects near a window. The layout-editor `window.png` raster that
 * also lived here went with its route in E4a.
 */

import { course, mapDocument, render, type MapWindow } from "@oxygen/shared";

/** Padding of the window crop, mm: strokes and symbols reach past their path. */
export const WINDOW_OBJECT_MARGIN_MM = 20;

/** Extent of one path, µm. `null` for an empty path. */
function pathExtent(coords: Int32Array): render.Bounds | null {
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
export function objectsNear(objects: readonly render.RenderObject[], bbox: MapWindow, marginMm: number): render.RenderObject[] {
  const m = marginMm * 1000;
  const minX = bbox.minX * 1000 - m, maxX = (bbox.minX + bbox.width) * 1000 + m;
  const minY = bbox.minY * 1000 - m, maxY = (bbox.minY + bbox.height) * 1000 + m;
  return objects.filter((o) => {
    const e = pathExtent(o.path.coords);
    return !!e && e.maxX >= minX && e.minX <= maxX && e.maxY >= minY && e.minY <= maxY;
  });
}

export interface PreparedDocument {
  colours: mapDocument.DocumentColour[];
  input: mapDocument.DocumentRenderInput;
  /** The header (course layer context and georeferencing for the page composer, C2). */
  header: mapDocument.MapDocumentHeader;
  /** Point features automatic overprint cuts go around (`cutFeaturesOfDocument`, docs/course-layer.md §3.4). */
  cutFeatures: course.CutFeature[];
}

const prepared = new Map<string, Promise<PreparedDocument>>();
const PREPARED_MAX = 2;

/**
 * Decoded + bridged document, kept for the last two hashes: the sheets
 * of one print share one decode through the in-flight promise.
 */
export function prepareDocument(hash: string, bytes: () => Promise<Uint8Array> | Uint8Array): Promise<PreparedDocument> {
  const hit = prepared.get(hash);
  if (hit) {
    prepared.delete(hash);
    prepared.set(hash, hit);
    return hit;
  }
  const entry = (async (): Promise<PreparedDocument> => {
    const doc = mapDocument.decodeMapDocument(await bytes());
    return { colours: doc.header.colours, input: mapDocument.documentRenderInput(doc), header: doc.header, cutFeatures: course.cutFeaturesOfDocument(doc) };
  })();
  prepared.set(hash, entry);
  entry.catch(() => {
    if (prepared.get(hash) === entry) prepared.delete(hash);
  });
  while (prepared.size > PREPARED_MAX) prepared.delete(prepared.keys().next().value as string);
  return entry;
}

export function resetPreparedDocuments(): void {
  prepared.clear();
}
