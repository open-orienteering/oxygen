/**
 * Document window raster (docs/course-print.md §10): the layout-editor
 * `window.png` of a `vector` event, drawn from the pinned map document
 * through the reference raster. Pure over its inputs; the route, the
 * render gate and the PNG cache are in `course-maps/routes.ts`.
 */

import { course, mapDocument, render, windowBoundingBox, windowRotationDeg, type MapWindow } from "@oxygen/shared";
import { glyphOutlineFrom, loadBundledFont } from "./fonts.js";
import { encodePng, rasterisePassStream } from "./reference-raster.js";
import { stackColour } from "./previews.js";

/** Same padding as the legacy `objectsInWindow` crop: strokes and symbols reach past their path. */
export const WINDOW_OBJECT_MARGIN_MM = 20;

export type WindowLayer = "full" | "ink";

/**
 * Stack index of lower purple: passes at or below it are the "lower"
 * half of the editor's sandwich, passes above it the ink (05 §3). A
 * stack without a `purple-lower` palette id falls back to the first
 * entry with `purpleRole: "lower"`; `null` when there is none.
 */
export function inkBoundary(colours: readonly mapDocument.DocumentColour[]): number | null {
  const byId = colours.findIndex((c) => c.paletteIds?.includes("purple-lower"));
  if (byId >= 0) return byId;
  const byRole = colours.findIndex((c) => c.purpleRole === "lower");
  return byRole >= 0 ? byRole : null;
}

/** The passes whose colour satisfies `keep`, with their object / symbol columns and shared tables. */
export function filterPassStream(stream: render.PassStream, keep: (colour: number) => boolean): render.PassStream {
  const passes: render.Pass[] = [];
  const objectIdx: number[] = [];
  const symbolIdx: number[] = [];
  stream.passes.forEach((p, i) => {
    if (!keep(p.colour)) return;
    passes.push(p);
    objectIdx.push(stream.objectIdx[i]);
    symbolIdx.push(stream.symbolIdx[i]);
  });
  return {
    passes,
    objectIdx: Uint32Array.from(objectIdx),
    symbolIdx: Uint32Array.from(symbolIdx),
    glyphTable: stream.glyphTable,
    fontTable: stream.fontTable,
  };
}

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
const warnedNoBoundary = new Set<string>();

/**
 * Decoded + bridged document, kept for the last two hashes: a window drag
 * sends many requests at one document, and the editor's first burst
 * (full / ink × two resolutions) shares one decode through the in-flight promise.
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
  warnedNoBoundary.clear();
}

export interface DocumentWindowOptions {
  /** Paper mm, y-up, rotation as `mapWindowForFrame` returns it (clockwise positive on the page). */
  window: MapWindow;
  widthPx: number;
  heightPx: number;
  layer: WindowLayer;
  /** Document hash; only used to log the missing-boundary warning once. */
  hash?: string;
}

/** RGBA PNG of the window, exactly `widthPx × heightPx`. */
export async function renderDocumentWindow(doc: PreparedDocument, opts: DocumentWindowOptions): Promise<Buffer> {
  const { window, widthPx, heightPx, layer } = opts;
  const rotation = windowRotationDeg(window);
  const bbox = windowBoundingBox(window);
  const fonts = await Promise.all([loadBundledFont("liberation-sans"), loadBundledFont("liberation-sans-narrow")]);
  const objects = objectsNear(doc.input.objects, bbox, WINDOW_OBJECT_MARGIN_MM);
  const { stream: full } = render.symbolise({ objects, symbols: doc.input.symbols, fonts });

  let stream = full;
  if (layer === "ink") {
    const boundary = inkBoundary(doc.colours);
    if (boundary === null) {
      const key = opts.hash ?? "";
      if (!warnedNoBoundary.has(key)) {
        warnedNoBoundary.add(key);
        console.warn(`[window-raster] document ${key || "?"} has no purple-lower colour: ink layer is empty; re-import the map`);
      }
      stream = filterPassStream(full, () => false);
    } else {
      stream = filterPassStream(full, (c) => c > boundary);
    }
  }

  // The raster covers the axis-aligned bbox of the (rotated) window, so
  // after rotating it about its centre the frame is fully covered.
  const pxPerMm = widthPx / window.width;
  const bounds: render.Bounds = {
    minX: bbox.minX * 1000,
    minY: bbox.minY * 1000,
    maxX: (bbox.minX + bbox.width) * 1000,
    maxY: (bbox.minY + bbox.height) * 1000,
  };
  const img = await rasterisePassStream(stream, {
    colour: stackColour(doc.colours),
    bounds,
    pxPerMm,
    background: layer === "full" ? "#ffffff" : "none",
    glyphOutline: glyphOutlineFrom(fonts),
  });
  const png = await encodePng(img);
  const sharp = (await import("sharp")).default;
  const background = layer === "full" ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 };
  let pipeline = sharp(png);
  if (rotation !== 0) {
    const rotated = await pipeline.rotate(rotation, { background }).png().toBuffer();
    const meta = await sharp(rotated).metadata();
    pipeline = sharp(rotated);
    const left = Math.max(0, Math.round(((meta.width ?? widthPx) - widthPx) / 2));
    const top = Math.max(0, Math.round(((meta.height ?? heightPx) - heightPx) / 2));
    pipeline = pipeline.extract({ left, top, width: Math.min(widthPx, (meta.width ?? widthPx) - left), height: Math.min(heightPx, (meta.height ?? heightPx) - top) });
  } else if (img.width !== widthPx || img.height !== heightPx) {
    pipeline = pipeline.resize(widthPx, heightPx, { fit: "fill" });
  }
  // Rounding of the bbox / window sizes can leave a pixel short: pad to the exact size.
  const out = await pipeline.png().toBuffer();
  const m = await sharp(out).metadata();
  if (m.width === widthPx && m.height === heightPx) return out;
  return sharp(out).resize(widthPx, heightPx, { fit: "fill" }).png().toBuffer();
}
