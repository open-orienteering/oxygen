/**
 * Preview PNGs (docs/map-storage.md §4.5): symbol swatches
 * (docs/map-rendering.md §5.1.1) and document thumbnails, drawn by the
 * reference raster. Pure over their inputs — the rows and routes that
 * store and serve them are in `map-store/previews.ts`.
 */

import { mapDocument, render } from "@oxygen/shared";
import { glyphOutlineFrom, loadBundledFont } from "./fonts.js";
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
  return Promise.all([loadBundledFont("liberation-sans"), loadBundledFont("liberation-sans-narrow")]);
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
