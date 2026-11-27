/**
 * Course-map pages from the prepared map document (docs/course-print.md
 * §4–7, §8.2): sheet → page input → `composePage` → `writePage`, many
 * pages into one `PdfWriter` so fonts, glyph forms and images are shared
 * (05 §5.10).
 *
 * Isomorphic (§1; 05 §5.11, G13): the API's print worker and the browser
 * run this one function, so equal inputs give equal bytes wherever the PDF
 * is made. What a host differs in arrives as input: the font files and
 * their metrics (`fonts`), the SVG rasteriser (`rasteriseSvg`; the API's
 * is resvg, the browser has none and is sent PNGs, §6.3) and how to yield
 * between pages (`yieldToHost`).
 */

import { windowBoundingBox } from "../course-maps/geometry.js";
import type { MapWindow } from "../course-maps/schema.js";
import type { SheetInput } from "../course-maps/resolve-sheet.js";
import { courseDocumentContext } from "../course/context.js";
import { type PaperFrame, epsgOf } from "../geo/projection.js";
import { type ImageWindow, cropInWindow, unionWindow } from "../render/image-window.js";
import type { FontFamily } from "../render/pass-stream.js";
import { type TrueTypeFont, parseTrueType } from "../render/truetype.js";
import type { ColourMode } from "./colour.js";
import { composePage, writePage } from "./compose.js";
import type { PageInput } from "./page.js";
import { type PreparedDocument, WINDOW_OBJECT_MARGIN_MM, objectsNear } from "./prepared-document.js";
import { type PdfFontFace, PdfWriter } from "./writer.js";

/** SVG logos are rasterised at this density of their placed size (§6.3). */
export const SVG_RASTER_DPI = 600;
/** …and never above this many pixels per side. */
export const SVG_RASTER_MAX_PX = 4096;

export interface PrintGraphic {
  mime: string;
  data: Uint8Array;
}

/**
 * The fonts a print embeds and measures with: the face files the writer
 * subsets (`faces`) and the parsed faces the composer lays text out with
 * (`metrics`), in the order `symbolise` prefers them (regular before bold).
 */
export interface PrintFonts {
  faces: PdfFontFace[];
  metrics: TrueTypeFont[];
}

/** `PrintFonts` from face files alone: each parsed in the given order (a host without a font cache). */
export function printFontsFromFaces(faces: readonly { family: FontFamily; data: Uint8Array }[]): PrintFonts {
  return {
    faces: [...faces],
    metrics: faces.map((f) => {
      const copy = new ArrayBuffer(f.data.byteLength);
      new Uint8Array(copy).set(f.data);
      return parseTrueType(copy, f.family);
    }),
  };
}

export interface CoursePagesOptions {
  /** The pinned document (`prepareDocument`). */
  document: PreparedDocument;
  /** `map_files.rotation_correction` of the pinned row (georeferencing of `/Measure /GEO`). */
  rotationCorrectionDeg?: number;
  sheets: PrintSheet[];
  /** The bundled faces (`packages/shared/fonts/`). */
  fonts: PrintFonts;
  /** Graphics referenced by image objects, by id. */
  graphics?: ReadonlyMap<number, PrintGraphic>;
  mode?: ColourMode;
  deterministic?: boolean;
  info?: { title?: string; author?: string; subject?: string };
  /** Text as embedded fonts (default, what the route prints) or as glyph outlines (the corpus run's geometry check, docs/course-print.md §11). */
  text?: "font" | "outline";
  /**
   * Rasteriser for SVG graphics, to PNG at an exact pixel box; `graphicId`
   * names the graphic (G15: a host without the SVG asks the server's
   * `print.png` for it, §8.5). `window` is the part of the graphic to
   * rasterise (fractions, top-left origin; absent = all, §6.3). Absent: an
   * SVG graphic is left out with an `SVG_RASTER` warning.
   */
  rasteriseSvg?: (svg: Uint8Array, widthPx: number, heightPx: number, graphicId: number, window?: ImageWindow) => Promise<Uint8Array>;
  /** Awaited before each composed sheet: the host's chance to run other work between pages (the API's event loop, §8.2). Absent: no yield. */
  yieldToHost?: () => Promise<void>;
  /** Called after each page is written (the print worker streams these back as progress). */
  onPage?: (page: { index: number; label: string; warnings: string[] }) => void;
}

/**
 * A sheet and how many identical pages it prints (F8's hand-out stack,
 * `copies=runners`; course-print.md §4.5): composed once, the copies
 * share its content stream (`PdfWriter.copyPage`). Absent = 1; 0 = none.
 */
export type PrintSheet = SheetInput & { copies?: number };

/**
 * A graphic that stands in for a control's circle or number could not be loaded (CRS-010, docs/course-print.md §8.2):
 * the page would print the control bare or without its number, so the print fails (a 400 on the route; the device
 * falls back to the server). Any other missing graphic stays a warning.
 */
export class PrintGraphicMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintGraphicMissingError";
  }
}

export interface CoursePagesResult {
  bytes: Uint8Array;
  pageCount: number;
  warnings: string[];
}

/** Pixel box for a graphic placed at `widthMm × heightMm` (its crop shows a fraction of the source, or of the rasterised window; §6.3). */
export function svgRasterBox(widthMm: number, heightMm: number, crop?: { width: number; height: number }): [number, number] {
  const px = (mm: number, frac: number) => Math.max(1, Math.round(((mm / frac) / 25.4) * SVG_RASTER_DPI));
  let w = px(widthMm, crop?.width ?? 1), h = px(heightMm, crop?.height ?? 1);
  const k = Math.min(1, SVG_RASTER_MAX_PX / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  return [w, h];
}

/** The `PaperFrame` of the document for `/Measure /GEO`; null when it has no projectable CRS. */
export function documentPaperFrame(doc: PreparedDocument, rotationCorrectionDeg = 0): PaperFrame | null {
  const frame: PaperFrame = {
    unitsPerMm: doc.header.unitsPerMm,
    mapScale: doc.header.mapScale,
    georeferencing: doc.header.georeferencing,
    correctionDeg: rotationCorrectionDeg,
  };
  return epsgOf(frame) ? frame : null;
}

/** The sheet plus the document's window objects: one page's composer input. */
export function pageInputFor(doc: PreparedDocument, sheet: SheetInput, geo: PaperFrame | null): PageInput {
  const bbox: MapWindow = windowBoundingBox(sheet.window);
  return {
    ...sheet,
    map: {
      objects: objectsNear(doc.input.objects, bbox, WINDOW_OBJECT_MARGIN_MM),
      symbols: doc.input.symbols,
      context: courseDocumentContext(doc.header),
      cutFeatures: doc.cutFeatures,
    },
    geo,
  };
}

/**
 * Every sheet as one page of one PDF. Throws `course.CourseStackError`
 * for a document whose colour stack is not aligned (a 400 on the route,
 * §8.1).
 */
export async function renderCoursePages(opts: CoursePagesOptions): Promise<CoursePagesResult> {
  const mode = opts.mode ?? "cmyk";
  const warnings: string[] = [];
  const fonts = opts.fonts.metrics;
  const writer = await PdfWriter.create({ faces: opts.fonts.faces, deterministic: opts.deterministic, info: opts.info, text: opts.text });
  warnings.push(...writer.warnings);
  // Patch ops that were skipped (docs/map-patches.md §2.3): the PDF is still written.
  for (const issue of opts.document.patchIssues) warnings.push(`PATCH_ISSUE: ${issue.opId}: ${issue.code}`);
  const geo = documentPaperFrame(opts.document, opts.rotationCorrectionDeg);
  const rasterise = opts.rasteriseSvg;
  const pngCache = new Map<string, Uint8Array>();

  let pageCount = 0;
  for (const [index, { copies = 1, ...sheet }] of opts.sheets.entries()) {
    if (copies < 1) continue;
    const pageWarnings: string[] = [];
    await opts.yieldToHost?.();
    const page = composePage(pageInputFor(opts.document, sheet, geo), fonts);
    for (const w of page.warnings) pageWarnings.push(`${sheet.label}: ${w.code}: ${w.message}`);
    const images = new Map<number, Uint8Array>();
    const windows = new Map<number, ImageWindow>();
    // SVG: one raster per graphic and page, over the union of its crops (§6.3), at the largest box a placement needs.
    const svgPlacements = new Map<number, typeof page.images>();
    const rasterFailures = new Map<number, string>();
    for (const img of page.images) {
      const g = opts.graphics?.get(img.graphicId);
      if (!g) continue;
      if (g.mime === "image/png") images.set(img.graphicId, g.data);
      else if (g.mime === "image/svg+xml") svgPlacements.set(img.graphicId, [...(svgPlacements.get(img.graphicId) ?? []), img]);
    }
    for (const [graphicId, placed] of svgPlacements) {
      const g = opts.graphics!.get(graphicId)!;
      const window = unionWindow(placed.map((i) => i.crop));
      let box: [number, number] = [0, 0];
      for (const img of placed) {
        // Placed size on paper: page objects in page mm; image course objects enlarge with T_map.
        const k = img.layer === "map" ? page.mapLayer.transform.scaleRatio : 1;
        const b = svgRasterBox((img.sizeUm[0] / 1000) * k, (img.sizeUm[1] / 1000) * k, cropInWindow(img.crop, window));
        if (b[0] * b[1] > box[0] * box[1]) box = b;
      }
      const [w, h] = box;
      const key = `${graphicId}/${w}x${h}${window ? `/${window.x},${window.y},${window.width},${window.height}` : ""}`;
      let png = pngCache.get(key);
      if (!png) {
        try {
          if (!rasterise) throw new Error("no SVG rasteriser");
          png = await (window ? rasterise(g.data, w, h, graphicId, window) : rasterise(g.data, w, h, graphicId));
          pngCache.set(key, png);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          rasterFailures.set(graphicId, reason);
          pageWarnings.push(`${sheet.label}: SVG_RASTER: graphic ${graphicId}: ${reason}`);
          continue;
        }
      }
      images.set(graphicId, png);
      if (window) windows.set(graphicId, window);
    }
    // A graphic that hides a control's circle or number must be there (CRS-010): without it the control prints bare.
    const onMap = new Set(page.images.filter((i) => i.layer === "map").map((i) => i.graphicId));
    for (const o of sheet.course.objects ?? []) {
      if (o.kind !== "image" || !o.attach || !(o.props.hideControlCircle || o.props.hideControlNumber)) continue;
      const graphicId = o.props.graphicId;
      if (!onMap.has(graphicId) || images.has(graphicId)) continue;
      const controlId = String(o.attach.controlId);
      // Only a hide that is drawn with its control on this page counts (an undrawn control hides nothing).
      const site = sheet.course.sites.find((s) => s.id === controlId);
      if (!site || (site.x === 0 && site.y === 0)) continue;
      const code = site.code ?? controlId;
      const why = rasterFailures.get(graphicId);
      throw new PrintGraphicMissingError(
        `${sheet.label}: graphic ${graphicId} could not be loaded and it replaces the circle or number of control ${code}; restore the graphic or untick the hide options${why ? ` (${why})` : ""}`,
      );
    }
    const written = await writePage(writer, page, { mode, images, windows });
    if (copies > 1) writer.copyPage(written.page, copies - 1);
    pageCount += copies;
    for (const w of written.warnings) pageWarnings.push(`${sheet.label}: ${w}`);
    warnings.push(...pageWarnings);
    opts.onPage?.({ index, label: sheet.label, warnings: pageWarnings });
  }
  const bytes = await writer.save();
  return { bytes, pageCount, warnings };
}
