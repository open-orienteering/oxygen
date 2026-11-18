/**
 * Preview PNGs (docs/map-storage.md §4.5): symbol swatches
 * (docs/map-rendering.md §5.1.1) and document thumbnails, drawn by the
 * reference raster. Pure over their inputs — the rows and routes that
 * store and serve them are in `map-store/previews.ts`.
 */

import { mapDocument, render } from "@oxygen/shared";
import { glyphOutlineFrom, loadBundledFonts } from "./fonts.js";
import { type RasterImage, encodePng, rasterisePassStream } from "./reference-raster.js";

export const THUMBNAIL_LONG_EDGE_PX = 512;
/**
 * Above this many objects a document gets no thumbnail: symbolising it
 * into one SVG for resvg costs seconds and hundreds of MB on the API
 * process. Set from the corpus measurement in docs/map-storage.md §4.5.
 */
export const THUMBNAIL_MAX_OBJECTS = 60_000;
const THUMBNAIL_PAPER = "#ffffff";

export type ColourLookup = (idx: number) => string;

/** Colour stack → hex lookup through the shared screen conversion; magenta for a dangling index. */
export function stackColour(stack: readonly render.ColourEntry[]): ColourLookup {
  const hex = stack.map((c) => render.cmykToHex(c.cmyk));
  return (i) => hex[i] ?? "#ff00ff";
}

function bundledFonts(): Promise<render.TrueTypeFont[]> {
  return loadBundledFonts();
}

/** One symbol on the swatch scene, as RGBA. */
export async function renderSwatch(symbol: render.RenderSymbol, colour: ColourLookup): Promise<RasterImage> {
  const fonts = await bundledFonts();
  const { stream, frame } = render.symboliseSwatch(symbol, fonts);
  return rasterisePassStream(stream, {
    colour,
    bounds: frame.bounds,
    pxPerMm: render.SWATCH.pxPerMm,
    background: render.SWATCH.background,
    glyphOutline: glyphOutlineFrom(fonts),
  });
}

export async function renderSwatchPng(symbol: render.RenderSymbol, colour: ColourLookup): Promise<Buffer> {
  return encodePng(await renderSwatch(symbol, colour));
}

export type ThumbnailResult = { png: Buffer } | { skipped: "too-many-objects"; objects: number };

/**
 * The whole document — canonical layer, hidden symbols off — on white
 * paper, print window if there is one, else the object bounds, long edge
 * `THUMBNAIL_LONG_EDGE_PX`.
 */
export async function renderThumbnailPng(documentBytes: Uint8Array, opts: { maxObjects?: number } = {}): Promise<ThumbnailResult> {
  const doc = mapDocument.decodeMapDocument(documentBytes);
  const objects = doc.header.objects.count;
  if (objects > (opts.maxObjects ?? THUMBNAIL_MAX_OBJECTS)) return { skipped: "too-many-objects", objects };

  const fonts = await bundledFonts();
  const input = mapDocument.documentRenderInput(doc);
  const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts });
  const bounds = thumbnailBounds(doc.header);
  const longMm = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) / 1000;
  const img = await rasterisePassStream(stream, {
    colour: stackColour(doc.header.colours),
    bounds,
    pxPerMm: THUMBNAIL_LONG_EDGE_PX / longMm,
    background: THUMBNAIL_PAPER,
    glyphOutline: glyphOutlineFrom(fonts),
  });
  return { png: await encodePng(img) };
}

/** Paper µm: the print window, else the header's object bounds. */
export function thumbnailBounds(header: Pick<mapDocument.MapDocumentHeader, "printWindow" | "bounds" | "unitsPerMm">): render.Bounds {
  const w = header.printWindow;
  if (w && w.right > w.left && w.top > w.bottom) {
    return { minX: w.left * 1000, minY: w.bottom * 1000, maxX: w.right * 1000, maxY: w.top * 1000 };
  }
  const k = 1000 / header.unitsPerMm;
  const b = header.bounds;
  return { minX: b.minX * k, minY: b.minY * k, maxX: b.maxX * k, maxY: b.maxY * k };
}

// ---- the colour panel's picture (docs/map-symbols.md §8.7 "Colour layers") ------

/** The picture's window is at most this many paper mm square… */
export const COLOUR_PICTURE_MAX_MM = 80;
/** …drawn at this resolution, so at most 480 px a side. */
export const COLOUR_PICTURE_PX_PER_MM = 6;
/** Objects this far outside the window are drawn too, so a symbol that reaches into it is whole. */
const COLOUR_PICTURE_MARGIN_UM = 5_000;

/**
 * The window the before / after picture shows (paper µm): the map's
 * bounds (as the thumbnail's) when they fit `COLOUR_PICTURE_MAX_MM`, else
 * the square tile of that size, on a grid from the bounds' lower left,
 * with the most objects (by the centre of their boxes; ties to the lowest
 * row, then column), clipped to the bounds. A function of the objects'
 * geometry alone, which both colour orders share, so the two pictures
 * show the same place.
 */
export function colourPictureWindow(doc: mapDocument.MapDocument): render.Bounds {
  const bounds = thumbnailBounds(doc.header);
  const t = COLOUR_PICTURE_MAX_MM * 1000;
  const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / t));
  const ny = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / t));
  if (nx === 1 && ny === 1) return bounds;
  const counts = new Array<number>(nx * ny).fill(0);
  const k = 1000 / doc.header.unitsPerMm;
  for (let i = 0; i < doc.header.objects.count; i++) {
    const o = i * 4;
    const cx = ((doc.bboxes[o] + doc.bboxes[o + 2]) / 2) * k;
    const cy = ((doc.bboxes[o + 1] + doc.bboxes[o + 3]) / 2) * k;
    if (cx < bounds.minX || cx > bounds.maxX || cy < bounds.minY || cy > bounds.maxY) continue;
    const x = Math.min(nx - 1, Math.floor((cx - bounds.minX) / t));
    const y = Math.min(ny - 1, Math.floor((cy - bounds.minY) / t));
    counts[y * nx + x] += 1;
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
  const x = best % nx, y = Math.floor(best / nx);
  return {
    minX: bounds.minX + x * t,
    minY: bounds.minY + y * t,
    maxX: Math.min(bounds.maxX, bounds.minX + (x + 1) * t),
    maxY: Math.min(bounds.maxY, bounds.minY + (y + 1) * t),
  };
}

/** The objects of `doc` whose boxes meet `window` widened by the margin. */
export function objectsNear(doc: mapDocument.MapDocument, window: render.Bounds): number[] {
  const k = doc.header.unitsPerMm / 1000;
  const m = COLOUR_PICTURE_MARGIN_UM;
  const b = { minX: (window.minX - m) * k, minY: (window.minY - m) * k, maxX: (window.maxX + m) * k, maxY: (window.maxY + m) * k };
  const only: number[] = [];
  for (let i = 0; i < doc.header.objects.count; i++) {
    const o = i * 4;
    if (doc.bboxes[o] <= b.maxX && doc.bboxes[o + 2] >= b.minX && doc.bboxes[o + 1] <= b.maxY && doc.bboxes[o + 3] >= b.minY) only.push(i);
  }
  return only;
}

/** `doc` over `window` (paper µm) by the reference raster on white paper, in its own colour stack. */
export async function renderColourPicture(doc: mapDocument.MapDocument, window: render.Bounds): Promise<RasterImage> {
  const fonts = await bundledFonts();
  const input = mapDocument.documentRenderInput(doc, { only: objectsNear(doc, window) });
  const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts });
  return rasterisePassStream(stream, {
    colour: stackColour(doc.header.colours),
    bounds: window,
    pxPerMm: COLOUR_PICTURE_PX_PER_MM,
    background: THUMBNAIL_PAPER,
    glyphOutline: glyphOutlineFrom(fonts),
  });
}

export async function renderColourPicturePng(doc: mapDocument.MapDocument, window: render.Bounds): Promise<Buffer> {
  return encodePng(await renderColourPicture(doc, window));
}
