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

import { course, courseMapObjectSchema, courseMapOverridesSchema, mapGeo, setterSheetPropsSchema, windowBoundingBox, type MapWindow } from "@oxygen/shared";
import { type ColourMode, PdfWriter, composePage, writePage, type PageInput } from "@oxygen/shared/print";
import { z } from "zod";
import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { getBlob } from "../map-store/blob-store.js";
import { type PreparedDocument, WINDOW_OBJECT_MARGIN_MM, objectsNear, prepareDocument } from "../render/window-raster.js";
import { BUNDLED_FONT_FILES, bundledPdfFaces, loadBundledFonts } from "../render/fonts.js";
import { type BaseMapInfo, getBaseMapInfo } from "./map-source.js";
import { type LayoutControlSource, type LayoutTemplateSource, centerOfControls, layoutControlsFromCourseControls, layoutCourseEnds, layoutCrossings } from "./resolve-layout.js";
import { type ResolveSheetInput, type SheetInput, resolveSheet } from "./resolve-sheet.js";
import { objectsInScope, type StoredCourseObject } from "../course-objects.js";

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

/** The fields of a `course_maps` row (with template and course) a sheet reads — what `maps.pdf` loads today. */
export interface PrintMapRow {
  name: string;
  kind: string;
  /** `course_maps.section_index`: the part of a course split by map exchanges (course-layer.md §11); absent = 0. */
  sectionIndex?: number;
  /** `course_maps.props`: a setter sheet's group (`setterSheetPropsSchema`, docs/course-layout.md §8); absent = `{}`. */
  props?: unknown;
  overrides: unknown;
  objects: unknown;
  windowCenter: unknown;
  /** F8: the variant this page prints (`rowForVariant`; `{variant}`, course-print.md §4.6). */
  variantKey?: string;
  /** F8: a variant page's root structure (`rowForVariant`): the shared window centres on every alternative. */
  rootStructure?: unknown;
  /** F8: the all-variations page of a root (`allVariationsRow`): its variants' keys. */
  allVariations?: { keys: string[] };
  template: LayoutTemplateSource | null;
  course: {
    id?: string | number | bigint;
    name: string;
    lengthM: number;
    climbM: number;
    orderMode: "ordered" | "free_order";
    /** `courses.structure` JSONB: the sequence's ends and the authored leg gaps (NULL = the columns below). */
    structure?: unknown;
    startName: string;
    finishControlId: string | null;
    firstAsStart: boolean;
    lastAsFinish: boolean;
    descriptionInstructions: unknown;
    classes: Array<{ name: string }>;
    courseControls: Array<{ control: LayoutControlSource; labelDx?: number | null; labelDy?: number | null }>;
  } | null;
}

/** A class's print override (docs/course-layout.md §6; 08 §4.4). */
export interface ClassPrint {
  name: string;
  printScale: number | null;
  /** The class's `sheet_template_id` row. */
  sheetTemplate: LayoutTemplateSource | null;
}

/**
 * A sheet as one class prints it (docs/course-layout.md §6): the
 * description header names that class only. A class sheet
 * (`course_maps.class_id`) already carries the class's template and scale;
 * a course sheet printed for a class (the class has no sheets of its own)
 * takes them here — the template `sheet_template_id ?? the sheet's`, the
 * scale `print_scale ??` the template's. Both pipelines print the result.
 */
export function rowForClass<R extends PrintMapRow>(row: R, cls: ClassPrint, classSheet: boolean): R {
  const course = row.course ? { ...row.course, classes: [{ name: cls.name }] } : null;
  if (classSheet) return { ...row, course };
  const overrides = { ...((row.overrides ?? {}) as Record<string, unknown>) };
  if (cls.printScale !== null) overrides.printScale = cls.printScale;
  else if (cls.sheetTemplate) delete overrides.printScale;
  return { ...row, course, template: cls.sheetTemplate ?? row.template, overrides };
}

/** The fields of a materialised variant (a child `courses` row, course-layer.md §12) a variant page reads. */
export type VariantCourse = Pick<
  NonNullable<PrintMapRow["course"]>,
  "name" | "lengthM" | "climbM" | "orderMode" | "structure" | "startName" | "finishControlId" | "firstAsStart" | "lastAsFinish" | "descriptionInstructions" | "courseControls"
> & { variantKey: string | null };

/**
 * A root's sheet as one variant prints it (course-print.md §4.6, F8; 08
 * §4.6 "the sheet shared by variants"): the row's layout, template and
 * window, the course drawn and described from the materialised child —
 * its name `<root> <key>` (page label, outline, block header, `{course}`),
 * its linear structure, controls, label offsets, length — and `{variant}`
 * the key. The course's id and classes stay the root's: course objects
 * are scoped to the root, and a class prints its root (`rowForClass` first).
 */
export function rowForVariant<R extends PrintMapRow>(row: R, child: VariantCourse): R {
  if (!row.course) return row;
  // Field by field: a child row carries its own id and (no) classes, which stay the root's.
  const fields: Omit<VariantCourse, "variantKey"> = {
    name: child.name,
    lengthM: child.lengthM,
    climbM: child.climbM,
    orderMode: child.orderMode,
    structure: child.structure,
    startName: child.startName,
    finishControlId: child.finishControlId,
    firstAsStart: child.firstAsStart,
    lastAsFinish: child.lastAsFinish,
    descriptionInstructions: child.descriptionInstructions,
    courseControls: child.courseControls,
  };
  return { ...row, variantKey: child.variantKey ?? "", rootStructure: row.course.structure, course: { ...row.course, ...fields } };
}

/** The keys as the all-variations page names them: `AB/BA`, a long list cut after five (`AA/AB/AC/BA/BB/…`). */
export function allVariationsSuffix(keys: readonly string[]): string {
  return keys.length <= 5 ? keys.join("/") : `${keys.slice(0, 5).join("/")}/…`;
}

/**
 * A root's sheet as the all-variations page (course-print.md §4.6, F8;
 * answer 4): every alternative drawn in the one purple for officials, the
 * name `<root> <keys>`, `{variant}` the keys.
 */
export function allVariationsRow<R extends PrintMapRow>(row: R, keys: readonly string[]): R {
  if (!row.course) return row;
  return { ...row, allVariations: { keys: [...keys] }, course: { ...row.course, name: `${row.course.name} ${allVariationsSuffix(keys)}` } };
}

/**
 * The all-variations page's controls: every control any alternative
 * visits, once, in first-seen order — the root's own rows (label offsets)
 * where it has them, else the event's control — without the course's
 * start and finish.
 */
function allVariationControls(
  c: NonNullable<PrintMapRow["course"]>,
  allControls: MapRowContext["allControls"],
  ends: { start: LayoutControlSource | null; finish: LayoutControlSource | null } | null,
): LayoutControlSource[] {
  const parsed = c.structure ? course.courseStructureSchema.safeParse(c.structure) : null;
  const own = layoutControlsFromCourseControls(c.courseControls);
  if (!parsed?.success) return own;
  const byOwn = new Map(own.map((row) => [row.id, row]));
  const byId = new Map(allControls.map((row) => [row.id, row]));
  const skip = new Set([ends?.start?.id, ends?.finish?.id].filter((id): id is string => !!id));
  const out: LayoutControlSource[] = [];
  const seen = new Set<string>();
  const visit = (siteId: string) => {
    if (seen.has(siteId) || skip.has(siteId)) return;
    seen.add(siteId);
    const row = byOwn.get(siteId) ?? byId.get(siteId);
    if (row) out.push(row);
  };
  for (const item of parsed.data.items) {
    if (item.kind === "variation") for (const alt of item.alternatives) for (const x of alt.items) visit(x.siteId);
    else visit(item.siteId);
  }
  return out;
}

/**
 * The window centre a root's pages share (course-print.md §4.6): the
 * middle of every site any alternative visits and the course's ends —
 * what a NULL centre of the all-variations page is, so every variant page
 * shows the same window. Null (the page centres as any course) without
 * groups, or for a course split by map exchanges (its parts centre on
 * their own controls, course-layer.md §11).
 */
export function sharedWindowCentre(
  structure: unknown,
  ends: { start: LayoutControlSource | null; finish: LayoutControlSource | null } | null,
  allControls: MapRowContext["allControls"],
): { x: number; y: number } | null {
  const parsed = structure ? course.courseStructureSchema.safeParse(structure) : null;
  if (!parsed?.success || !course.hasVariations(parsed.data)) return null;
  const ids = new Set([...course.structureSiteIds(parsed.data), ends?.start?.id, ends?.finish?.id]);
  const sites = allControls.filter((c) => ids.has(c.id) && (c.xpos !== 0 || c.ypos !== 0) && c.kind !== "crossing_point" && c.kind !== "map_issue");
  if (sites.some((c) => c.kind === "map_exchange")) return null;
  return centerOfControls(sites.map((c) => ({ x: c.xpos, y: c.ypos })));
}

/** What `sheetForMapRow` and the editor's `courseMap.resolveSheet` read besides the row. */
export interface MapRowContext {
  event: { name: string; date: Date };
  /** The event's live controls; `name` and `kind` resolve a course's start and finish (`layoutCourseEnds`). */
  allControls: Array<LayoutControlSource & { name: string; kind: string }>;
  /** Null fields without a base map (the editor's read; `maps.pdf` always has one). */
  mapInfo: { scale: number | null; meridianTiltDeg: number | null };
  courseObjects?: readonly StoredCourseObject[];
  classesByCourse?: ReadonlyMap<string, string[]>;
  /** `Event.autoOverprintCuts`; `false` = no automatic cuts on the sheet (course-layer.md §3.4). Absent = on. */
  autoCuts?: boolean;
}

/**
 * One map row → the `resolveSheet` input: the course's start and finish
 * by the one sequence rule over `ctx.allControls` (`layoutCourseEnds`;
 * docs/course-print.md §5.2), never the stored GeoJSON. `courseObjects` are the
 * event's (`loadCourseObjects`); the sheet takes those in scope of its
 * course, or the `all`-scoped ones for an all-controls sheet
 * (course-layer.md §8.3).
 */
export function sheetInputForMapRow(row: PrintMapRow, ctx: MapRowContext): ResolveSheetInput {
  if (!row.template) throw new Error(`Map "${row.name}" has no template`);
  if (row.kind === "setter") return setterSheetInput(row, ctx);
  const courseUuid = row.kind === "course" && row.course?.id !== undefined ? String(row.course.id) : null;
  const inScope = ctx.courseObjects ? objectsInScope(ctx.courseObjects, courseUuid, ctx.classesByCourse ?? new Map()) : [];
  const ends = row.course
    ? layoutCourseEnds(
        { ...row.course, structure: row.course.structure ?? null },
        row.course.courseControls.map((cc) => cc.control.id),
        ctx.allControls,
      )
    : null;
  const all = row.kind === "course" && !!row.allVariations && !!row.course;
  const stored = row.windowCenter && typeof row.windowCenter === "object" ? z.object({ x: z.number(), y: z.number() }).parse(row.windowCenter) : null;
  // A root's pages share one window (F8): a NULL centre centres on every alternative — its own read too.
  const shared = !stored && row.course && row.kind === "course" ? sharedWindowCentre(row.rootStructure ?? row.course.structure, ends, ctx.allControls) : null;
  return {
    kind: row.kind,
    template: row.template,
    overrides: courseMapOverridesSchema.parse(row.overrides),
    objects: mapObjectsSchema.parse(row.objects),
    course: row.course
      ? {
          name: row.course.name,
          lengthM: row.course.lengthM,
          climbM: row.course.climbM,
          // The all-variations block lists each control once, by code (no sequence: there is none).
          orderMode: all ? "free_order" : row.course.orderMode,
          start: ends?.start ?? null,
          finish: ends?.finish ?? null,
          classes: row.course.classes,
          controls: all ? allVariationControls(row.course, ctx.allControls, ends) : layoutControlsFromCourseControls(row.course.courseControls),
          descriptionInstructions: row.course.descriptionInstructions,
          crossings: layoutCrossings(row.course.structure ?? null, ctx.allControls),
        }
      : null,
    allControls: ctx.allControls,
    windowCenter: stored ?? shared,
    mapScale: ctx.mapInfo.scale,
    meridianTiltDeg: ctx.mapInfo.meridianTiltDeg,
    event: ctx.event,
    mapName: row.name,
    ...(row.kind === "course" ? { section: row.sectionIndex ?? 0 } : {}),
    ...(row.variantKey !== undefined ? { variantKey: row.variantKey } : {}),
    ...(all ? { allVariations: true, variantKey: allVariationsSuffix(row.allVariations!.keys) } : {}),
    structure: row.course?.structure ?? null,
    ...(row.course?.id !== undefined ? { courseId: String(row.course.id) } : {}),
    courseObjects: inScope.map(({ id: _uuid, scope: _scope, z: _z, version: _v, seq, ...body }) => ({ ...body, id: seq }) as course.CourseLayerObject),
    ...(ctx.autoCuts === false ? { autoCuts: false } : {}),
  };
}

/** A setter sheet's group: the uuids of `props.controlIds`, empty when the props are not a setter's. */
export function setterControlIds(props: unknown): Set<string> {
  const parsed = setterSheetPropsSchema.safeParse(props);
  return new Set(parsed.success ? parsed.data.controlIds : []);
}

/**
 * A setter sheet (docs/course-layout.md §8; 08 §4.6): the sites of its
 * group only (`props.controlIds` among `ctx.allControls`) as the
 * all-controls sheet lists sites — codes, 702 / 710 by kind, the block in
 * code order — with no course (a course-scoped setter map draws no legs),
 * the `all`-scoped course objects, titled by the row's name.
 */
function setterSheetInput(row: PrintMapRow, ctx: MapRowContext): ResolveSheetInput {
  const group = setterControlIds(row.props);
  const inScope = ctx.courseObjects ? objectsInScope(ctx.courseObjects, null, ctx.classesByCourse ?? new Map()) : [];
  return {
    kind: "setter",
    template: row.template!,
    overrides: courseMapOverridesSchema.parse(row.overrides),
    objects: mapObjectsSchema.parse(row.objects),
    course: null,
    allControls: ctx.allControls.filter((c) => group.has(c.id)),
    windowCenter: row.windowCenter && typeof row.windowCenter === "object" ? z.object({ x: z.number(), y: z.number() }).parse(row.windowCenter) : null,
    mapScale: ctx.mapInfo.scale,
    meridianTiltDeg: ctx.mapInfo.meridianTiltDeg,
    event: ctx.event,
    mapName: row.name,
    structure: null,
    courseObjects: inScope.map(({ id: _uuid, scope: _scope, z: _z, version: _v, seq, ...body }) => ({ ...body, id: seq }) as course.CourseLayerObject),
    ...(ctx.autoCuts === false ? { autoCuts: false } : {}),
  };
}

/** One map row → its sheet (`sheetInputForMapRow` through `resolveSheet`). */
export function sheetForMapRow(row: PrintMapRow, ctx: MapRowContext): SheetInput {
  return resolveSheet(sheetInputForMapRow(row, ctx)).sheet;
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
