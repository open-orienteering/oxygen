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

import { readFile } from "node:fs/promises";
import { course, courseMapObjectSchema, courseMapOverridesSchema, mapGeo, windowBoundingBox, type MapWindow } from "@oxygen/shared";
import { type ColourMode, PdfWriter, composePage, writePage, type PageInput } from "@oxygen/shared/print";
import { z } from "zod";
import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { getBlob } from "../map-store/blob-store.js";
import { type PreparedDocument, WINDOW_OBJECT_MARGIN_MM, objectsNear, prepareDocument } from "../render/window-raster.js";
import { BUNDLED_FONT_FILES, loadBundledFont } from "../render/fonts.js";
import { type BaseMapInfo, getBaseMapInfo } from "./map-source.js";
import { type LayoutControlSource, type LayoutTemplateSource, layoutControlsFromCourseControls } from "./resolve-layout.js";
import { type SheetInput, resolveSheet } from "./resolve-sheet.js";

type Db = PrismaClient | Prisma.TransactionClient;

const mapObjectsSchema = z.array(courseMapObjectSchema);

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
  sheets: SheetInput[];
  /** Graphics referenced by image objects, by id. */
  graphics?: ReadonlyMap<number, PrintGraphic>;
  mode?: ColourMode;
  deterministic?: boolean;
  info?: { title?: string; author?: string; subject?: string };
  /** Text as embedded fonts (default, what the route prints) or as glyph outlines (the corpus run's geometry check, docs/course-print.md §11). */
  text?: "font" | "outline";
  /** Rasteriser for SVG graphics (tests inject one); default resvg. */
  rasteriseSvg?: (svg: Uint8Array, widthPx: number, heightPx: number) => Promise<Uint8Array>;
}

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
  return Promise.all(
    (["liberation-sans", "liberation-sans-narrow"] as const).map(async (family) => ({ family, data: new Uint8Array(await readFile(BUNDLED_FONT_FILES[family].path)) })),
  );
}

/**
 * Every sheet as one page of one PDF. Throws `course.CourseStackError`
 * for a document whose colour stack is not aligned (the route's fallback
 * is C3's call).
 */
export async function renderCoursePages(opts: CoursePagesOptions): Promise<CoursePagesResult> {
  const mode = opts.mode ?? "cmyk";
  const warnings: string[] = [];
  const fonts = await Promise.all([loadBundledFont("liberation-sans"), loadBundledFont("liberation-sans-narrow")]);
  const writer = await PdfWriter.create({ faces: await fontFaces(), deterministic: opts.deterministic, info: opts.info, text: opts.text });
  warnings.push(...writer.warnings);
  const geo = documentPaperFrame(opts.document, opts.rotationCorrectionDeg);
  const rasterise = opts.rasteriseSvg ?? rasteriseSvgGraphic;
  const pngCache = new Map<string, Uint8Array>();

  for (const sheet of opts.sheets) {
    // One page at a time on the event loop: let other requests (card
    // readouts) run between pages of a long export (course-print.md §8.2).
    await new Promise<void>((resolve) => setImmediate(resolve));
    const page = composePage(pageInputFor(opts.document, sheet, geo), fonts);
    for (const w of page.warnings) warnings.push(`${sheet.label}: ${w.code}: ${w.message}`);
    const images = new Map<number, Uint8Array>();
    for (const img of page.images) {
      const g = opts.graphics?.get(img.graphicId);
      if (!g) continue;
      if (g.mime === "image/png") images.set(img.graphicId, g.data);
      else if (g.mime === "image/svg+xml") {
        // Placed size on paper: page objects in page mm; map objects enlarge with T_map.
        const k = img.layer === "map" ? page.mapLayer.transform.scaleRatio : 1;
        const [w, h] = rasterBox((img.rectUm.width / 1000) * k, (img.rectUm.height / 1000) * k, img.crop);
        const key = `${img.graphicId}/${w}x${h}`;
        let png = pngCache.get(key);
        if (!png) {
          try {
            png = await rasterise(g.data, w, h);
            pngCache.set(key, png);
          } catch (err) {
            warnings.push(`${sheet.label}: SVG_RASTER: graphic ${img.graphicId}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
        images.set(img.graphicId, png);
      }
    }
    const written = await writePage(writer, page, { mode, images });
    for (const w of written.warnings) warnings.push(`${sheet.label}: ${w}`);
  }
  const bytes = await writer.save();
  return { bytes, pageCount: opts.sheets.length, warnings };
}

/** The fields of a `course_maps` row (with template and course) a sheet reads — what `maps.pdf` loads today. */
export interface PrintMapRow {
  name: string;
  kind: string;
  overrides: unknown;
  objects: unknown;
  windowCenter: unknown;
  template: LayoutTemplateSource | null;
  course: {
    id?: string | number | bigint;
    name: string;
    lengthM: number;
    climbM: number;
    orderMode: "ordered" | "free_order";
    geometry: unknown;
    geometrySource?: string | null;
    descriptionInstructions: unknown;
    classes: Array<{ name: string }>;
    courseControls: Array<{ control: LayoutControlSource; labelDx?: number | null; labelDy?: number | null }>;
  } | null;
}

/** One map row → its sheet, with the same layout input the legacy page uses (`routes.ts` `renderPage`). */
export function sheetForMapRow(
  row: PrintMapRow,
  ctx: { event: { name: string; date: Date }; allControls: LayoutControlSource[]; mapInfo: Pick<BaseMapInfo, "scale" | "meridianTiltDeg"> },
): SheetInput {
  if (!row.template) throw new Error(`Map "${row.name}" has no template`);
  const { sheet } = resolveSheet({
    kind: row.kind,
    template: row.template,
    overrides: courseMapOverridesSchema.parse(row.overrides),
    objects: mapObjectsSchema.parse(row.objects),
    course: row.course
      ? {
          name: row.course.name,
          lengthM: row.course.lengthM,
          climbM: row.course.climbM,
          orderMode: row.course.orderMode,
          geometry: row.course.geometry,
          classes: row.course.classes,
          controls: layoutControlsFromCourseControls(row.course.courseControls),
          descriptionInstructions: row.course.descriptionInstructions,
        }
      : null,
    allControls: ctx.allControls,
    windowCenter: row.windowCenter && typeof row.windowCenter === "object" ? z.object({ x: z.number(), y: z.number() }).parse(row.windowCenter) : null,
    mapScale: ctx.mapInfo.scale,
    meridianTiltDeg: ctx.mapInfo.meridianTiltDeg,
    event: ctx.event,
    mapName: row.name,
    geometrySource: row.course?.geometrySource ?? null,
    ...(row.course?.id !== undefined ? { courseId: String(row.course.id) } : {}),
  });
  return sheet;
}

export interface PinnedPrintDocument {
  info: BaseMapInfo;
  document: PreparedDocument;
  rotationCorrectionDeg: number;
}

/**
 * The event's pinned document for printing, or null on the legacy path
 * (`getBaseMapInfo().document` null: `legacy`, or `vector` without a pin).
 */
export async function loadPinnedPrintDocument(db: Db, eventId: bigint): Promise<PinnedPrintDocument | null> {
  const info = await getBaseMapInfo(db, eventId);
  if (!info.document) return null;
  const { hash } = info.document;
  const document = await prepareDocument(hash, async () => {
    const bytes = await getBlob(db, "map_documents", hash);
    if (!bytes) throw new Error("Pinned map document is missing");
    return bytes;
  });
  const row = await db.mapFile.findFirst({ where: { eventId, documentHash: hash }, orderBy: { uploadedAt: "desc" }, select: { rotationCorrection: true } });
  return { info, document, rotationCorrectionDeg: row?.rotationCorrection ?? 0 };
}
