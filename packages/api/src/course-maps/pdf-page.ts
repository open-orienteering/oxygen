/**
 * Course-map pages from the pinned map document (docs/course-print.md
 * §4–7): sheet → page input → `composePage` → `writePage`, many pages into
 * one `PdfWriter` so fonts, glyph forms and images are shared (05 §5.10).
 * The `maps.pdf` route switch is C3's; this module is what it calls.
 *
 * Node-side duties the isomorphic composer leaves to its caller: loading
 * the document and the bundled fonts, choosing the window's objects, and
 * rasterising SVG logos to PNG (resvg, 05 §5.7 a — at render time, so
 * `graphics` rows stay as uploaded).
 */

import { course, mapGeo, windowBoundingBox, type MapWindow, type SheetInput } from "@oxygen/shared";
import { type ColourMode, PdfWriter, composePage, writePage, type PageInput } from "@oxygen/shared/print";
import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { getBlob } from "../map-store/blob-store.js";
import { type PreparedDocument, WINDOW_OBJECT_MARGIN_MM, objectsNear, prepareDocument } from "../render/window-raster.js";
import { BUNDLED_FONT_FILES, bundledPdfFaces, loadBundledFonts } from "../render/fonts.js";
import { type BaseMapInfo, getBaseMapInfo } from "./map-source.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** SVG logos are rasterised at this density of their placed size. */
export const SVG_RASTER_DPI = 600;
/** …and never above this many pixels per side. */
export const SVG_RASTER_MAX_PX = 4096;

export interface PrintGraphic {
  mime: string;
  data: Uint8Array;
}

export interface CoursePagesOptions {
  /** The pinned document (`prepareDocument`). */
  document: PreparedDocument;
  /** `map_files.rotation_correction` of the pinned row (georeferencing of `/Measure /GEO`). */
  rotationCorrectionDeg?: number;
  sheets: PrintSheet[];
  /** Graphics referenced by image objects, by id. */
  graphics?: ReadonlyMap<number, PrintGraphic>;
  mode?: ColourMode;
  deterministic?: boolean;
  info?: { title?: string; author?: string; subject?: string };
  /** Text as embedded fonts (default, what the route prints) or as glyph outlines (the corpus run's geometry check, docs/course-print.md §11). */
  text?: "font" | "outline";
  /** Rasteriser for SVG graphics (tests inject one); default resvg. */
  rasteriseSvg?: (svg: Uint8Array, widthPx: number, heightPx: number) => Promise<Uint8Array>;
  /** Called after each page is written (the print worker streams these back as progress). */
  onPage?: (page: { index: number; label: string; warnings: string[] }) => void;
}

/**
 * A sheet and how many identical pages it prints (F8's hand-out stack,
 * `copies=runners`; course-print.md §4.5): composed once, the copies
 * share its content stream (`PdfWriter.copyPage`). Absent = 1; 0 = none.
 */
export type PrintSheet = SheetInput & { copies?: number };

export interface CoursePagesResult {
  bytes: Uint8Array;
  pageCount: number;
  warnings: string[];
}

/** resvg at an exact pixel box (aspect stretched like the legacy `preserveAspectRatio="none"`). */
export async function rasteriseSvgGraphic(svg: Uint8Array, widthPx: number, heightPx: number): Promise<Uint8Array> {
  const { Resvg } = await import("@resvg/resvg-js");
  const sharp = (await import("sharp")).default;
  // Text in a logo uses the bundled faces only: the same output on every host.
  const fontFiles = Object.values(BUNDLED_FONT_FILES).map((f) => f.path);
  const r = new Resvg(Buffer.from(svg), { fitTo: { mode: "width", value: widthPx }, font: { loadSystemFonts: false, fontFiles, defaultFontFamily: "Liberation Sans" } });
  const png = r.render().asPng();
  const meta = await sharp(png).metadata();
  if (meta.width === widthPx && meta.height === heightPx) return new Uint8Array(png);
  return new Uint8Array(await sharp(png).resize(widthPx, heightPx, { fit: "fill" }).png().toBuffer());
}

/** Pixel box for a graphic placed at `widthMm × heightMm` (its crop shows a fraction of the source). */
function rasterBox(widthMm: number, heightMm: number, crop?: { width: number; height: number }): [number, number] {
  const px = (mm: number, frac: number) => Math.max(1, Math.round(((mm / frac) / 25.4) * SVG_RASTER_DPI));
  let w = px(widthMm, crop?.width ?? 1), h = px(heightMm, crop?.height ?? 1);
  const k = Math.min(1, SVG_RASTER_MAX_PX / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  return [w, h];
}

/** The `PaperFrame` of the document for `/Measure /GEO`; null when it has no projectable CRS. */
export function documentPaperFrame(doc: PreparedDocument, rotationCorrectionDeg = 0): mapGeo.PaperFrame | null {
  const frame: mapGeo.PaperFrame = {
    unitsPerMm: doc.header.unitsPerMm,
    mapScale: doc.header.mapScale,
    georeferencing: doc.header.georeferencing,
    correctionDeg: rotationCorrectionDeg,
  };
  return mapGeo.epsgOf(frame) ? frame : null;
}

/** The sheet plus the document's window objects: one page's composer input. */
export function pageInputFor(doc: PreparedDocument, sheet: SheetInput, geo: mapGeo.PaperFrame | null): PageInput {
  const bbox: MapWindow = windowBoundingBox(sheet.window);
  return {
    ...sheet,
    map: {
      objects: objectsNear(doc.input.objects, bbox, WINDOW_OBJECT_MARGIN_MM),
      symbols: doc.input.symbols,
      context: course.courseDocumentContext(doc.header),
      cutFeatures: doc.cutFeatures,
    },
    geo,
  };
}

async function fontFaces() {
  return bundledPdfFaces();
}

/**
 * Every sheet as one page of one PDF. Throws `course.CourseStackError`
 * for a document whose colour stack is not aligned (the route's fallback
 * is C3's call).
 */
export async function renderCoursePages(opts: CoursePagesOptions): Promise<CoursePagesResult> {
  const mode = opts.mode ?? "cmyk";
  const warnings: string[] = [];
  const fonts = await loadBundledFonts();
  const writer = await PdfWriter.create({ faces: await fontFaces(), deterministic: opts.deterministic, info: opts.info, text: opts.text });
  warnings.push(...writer.warnings);
  const geo = documentPaperFrame(opts.document, opts.rotationCorrectionDeg);
  const rasterise = opts.rasteriseSvg ?? rasteriseSvgGraphic;
  const pngCache = new Map<string, Uint8Array>();

  let pageCount = 0;
  for (const [index, { copies = 1, ...sheet }] of opts.sheets.entries()) {
    if (copies < 1) continue;
    const pageWarnings: string[] = [];
    // One page at a time on the event loop: let other requests (card
    // readouts) run between pages of a long export (course-print.md §8.2).
    await new Promise<void>((resolve) => setImmediate(resolve));
    const page = composePage(pageInputFor(opts.document, sheet, geo), fonts);
    for (const w of page.warnings) pageWarnings.push(`${sheet.label}: ${w.code}: ${w.message}`);
    const images = new Map<number, Uint8Array>();
    for (const img of page.images) {
      const g = opts.graphics?.get(img.graphicId);
      if (!g) continue;
      if (g.mime === "image/png") images.set(img.graphicId, g.data);
      else if (g.mime === "image/svg+xml") {
        // Placed size on paper: page objects in page mm; image course objects enlarge with T_map.
        const k = img.layer === "map" ? page.mapLayer.transform.scaleRatio : 1;
        const [w, h] = rasterBox((img.rectUm.width / 1000) * k, (img.rectUm.height / 1000) * k, img.crop);
        const key = `${img.graphicId}/${w}x${h}`;
        let png = pngCache.get(key);
        if (!png) {
          try {
            png = await rasterise(g.data, w, h);
            pngCache.set(key, png);
          } catch (err) {
            pageWarnings.push(`${sheet.label}: SVG_RASTER: graphic ${img.graphicId}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
        images.set(img.graphicId, png);
      }
    }
    const written = await writePage(writer, page, { mode, images });
    if (copies > 1) writer.copyPage(written.page, copies - 1);
    pageCount += copies;
    for (const w of written.warnings) pageWarnings.push(`${sheet.label}: ${w}`);
    warnings.push(...pageWarnings);
    opts.onPage?.({ index, label: sheet.label, warnings: pageWarnings });
  }
  const bytes = await writer.save();
  return { bytes, pageCount, warnings };
}

/** The pinned document's identity, without decoding it. */
export interface PinnedPrintSource {
  info: BaseMapInfo;
  hash: string;
  rotationCorrectionDeg: number;
  /** The `map_documents` blob (throws when it is missing). */
  bytes: () => Promise<Uint8Array>;
}

/**
 * The event's pinned document for printing, not yet decoded. Throws "No
 * base map uploaded" without a pin (`getBaseMapInfo`). The route hands
 * this to the print worker, which decodes it on its own thread
 * (docs/course-print.md §8.2).
 */
export async function pinnedPrintSource(db: Db, eventId: bigint): Promise<PinnedPrintSource> {
  const info = await getBaseMapInfo(db, eventId);
  const { hash } = info.document;
  const row = await db.mapFile.findFirst({ where: { eventId, documentHash: hash }, orderBy: { uploadedAt: "desc" }, select: { rotationCorrection: true } });
  return {
    info,
    hash,
    rotationCorrectionDeg: row?.rotationCorrection ?? 0,
    bytes: async () => {
      const bytes = await getBlob(db, "map_documents", hash);
      if (!bytes) throw new Error("Pinned map document is missing");
      return bytes;
    },
  };
}

export interface PinnedPrintDocument {
  info: BaseMapInfo;
  document: PreparedDocument;
  rotationCorrectionDeg: number;
}

/** `pinnedPrintSource` decoded in this thread (corpus run, in-process tests). */
export async function loadPinnedPrintDocument(db: Db, eventId: bigint): Promise<PinnedPrintDocument> {
  const source = await pinnedPrintSource(db, eventId);
  const document = await prepareDocument(source.hash, source.bytes);
  return { info: source.info, document, rotationCorrectionDeg: source.rotationCorrectionDeg };
}
