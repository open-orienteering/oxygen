/**
 * The API's side of course-map printing (docs/course-print.md §8): the
 * pinned document from the database (`pinnedPrintSource`) and the Node
 * binding of the shared `renderCoursePages` (`@oxygen/shared/print`,
 * `course-pages.ts`; G13) — the bundled fonts read from disk, SVG logos
 * rasterised by resvg (05 §5.7 a — at render time, so `graphics` rows stay
 * as uploaded) and a yield to the event loop between pages. The print
 * worker (`print-worker.ts`) calls this binding; so do the tests.
 */

import {
  type CoursePagesOptions as SharedCoursePagesOptions,
  type CoursePagesResult,
  type ImageWindow,
  isWholeWindow,
  type PreparedDocument,
  type PrintPatch,
  renderCoursePages as renderSharedCoursePages,
  prepareDocument,
} from "@oxygen/shared/print";
import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { getBlob } from "../map-store/blob-store.js";
import { eventPrintPatch } from "../map-store/patches.js";
import { bundledPrintFonts } from "../render/fonts.js";
import { type BaseMapInfo, getBaseMapInfo } from "./map-source.js";
import { renderableSvg } from "./svg-sanitize.js";
import { svgFontOptions, windowedSvg } from "./svg-window.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The shared options less what this binding supplies: the bundled fonts and the yield; `rasteriseSvg` defaults to resvg. */
export type CoursePagesOptions = Omit<SharedCoursePagesOptions, "fonts" | "yieldToHost">;

/**
 * resvg at an exact pixel box (aspect stretched like the legacy
 * `preserveAspectRatio="none"`); over `window` of the graphic's canvas only
 * when given (course-print.md §6.3), so a crop gets the whole box. A
 * document the window wrapper cannot carry (it does not parse wrapped) gets
 * the window cut from a whole raster at the window's density instead.
 */
export async function rasteriseSvgGraphic(svg: Uint8Array, widthPx: number, heightPx: number, window?: ImageWindow): Promise<Uint8Array> {
  const { Resvg } = await import("@resvg/resvg-js");
  const sharp = (await import("sharp")).default;
  const font = svgFontOptions();
  // The re-serialised, validated tree, never the stored bytes; a graphic that no longer validates renders as nothing.
  const source = renderableSvg(svg);
  if (!source) return blankPng(sharp, widthPx, heightPx);
  if (window && !isWholeWindow(window)) {
    const canvas = new Resvg(source, { font });
    let png: Buffer;
    try {
      const windowed = Buffer.from(windowedSvg(source.toString("utf8"), [canvas.width, canvas.height], window, [widthPx, heightPx]), "utf8");
      png = new Resvg(windowed, { fitTo: { mode: "width", value: widthPx }, font }).render().asPng();
    } catch {
      // The wrapped document does not parse (markup the reframe cannot carry): the window cut from a whole raster.
      return windowFromWhole(Resvg, sharp, source, font, window, widthPx, heightPx);
    }
    return exactBox(sharp, png, widthPx, heightPx);
  }
  return exactBox(sharp, new Resvg(source, { fitTo: { mode: "width", value: widthPx }, font }).render().asPng(), widthPx, heightPx);
}

async function blankPng(sharp: Sharp, w: number, h: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
}

type ResvgCtor = typeof import("@resvg/resvg-js").Resvg;
type Sharp = typeof import("sharp").default;

/** A PNG at exactly `w × h` (stretched when resvg rounded differently). */
async function exactBox(sharp: Sharp, png: Buffer | Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const meta = await sharp(png).metadata();
  if (meta.width === w && meta.height === h) return new Uint8Array(png);
  return new Uint8Array(await sharp(png).resize(w, h, { fit: "fill" }).png().toBuffer());
}

/** The longest side the fallback's whole raster may have, px. */
const WINDOW_FALLBACK_MAX_PX = 16384;

/** Fallback for `rasteriseSvgGraphic`'s window: the whole canvas at the window's density (at most 16384 px a side), the window cut out and fitted to the box. */
async function windowFromWhole(Resvg: ResvgCtor, sharp: Sharp, svg: Buffer, font: ReturnType<typeof svgFontOptions>, window: ImageWindow, w: number, h: number): Promise<Uint8Array> {
  let fw = Math.ceil(w / window.width), fh = Math.ceil(h / window.height);
  const k = Math.min(1, WINDOW_FALLBACK_MAX_PX / Math.max(fw, fh));
  fw = Math.max(1, Math.round(fw * k));
  fh = Math.max(1, Math.round(fh * k));
  const whole = await exactBox(sharp, new Resvg(svg, { fitTo: { mode: "width", value: fw }, font }).render().asPng(), fw, fh);
  const left = Math.min(fw - 1, Math.floor(window.x * fw)), top = Math.min(fh - 1, Math.floor(window.y * fh));
  const width = Math.max(1, Math.min(fw - left, Math.round(window.width * fw))), height = Math.max(1, Math.min(fh - top, Math.round(window.height * fh)));
  return new Uint8Array(await sharp(whole).extract({ left, top, width, height }).resize(w, h, { fit: "fill" }).png().toBuffer());
}

/** One page at a time on the event loop: other requests (card readouts) run between pages of a long export (course-print.md §8.2). */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Every sheet as one page of one PDF (the shared `renderCoursePages` with
 * the bundled fonts, resvg and the event-loop yield). Throws
 * `course.CourseStackError` for a document whose colour stack is not
 * aligned.
 */
export async function renderCoursePages(opts: CoursePagesOptions): Promise<CoursePagesResult> {
  return renderSharedCoursePages({ ...opts, fonts: await bundledPrintFonts(), rasteriseSvg: opts.rasteriseSvg ?? ((svg, w, h, _id, window) => rasteriseSvgGraphic(svg, w, h, window)), yieldToHost: yieldToEventLoop });
}

/** The pinned document's identity, without decoding it. */
export interface PinnedPrintSource {
  info: BaseMapInfo;
  hash: string;
  rotationCorrectionDeg: number;
  /** The `map_documents` blob (throws when it is missing). */
  bytes: () => Promise<Uint8Array>;
  /** The event's patch on this document, or null when it changes nothing (`eventPrintPatch`; G14). */
  patch: PrintPatch | null;
}

/**
 * The event's pinned document for printing, not yet decoded, with the
 * event's patch on it (the effective document, docs/map-patches.md §2;
 * G14). Throws "No base map uploaded" without a pin (`getBaseMapInfo`).
 * The route hands this to the print worker, which decodes and patches it
 * on its own thread (docs/course-print.md §8.2).
 */
export async function pinnedPrintSource(db: Db, eventId: bigint): Promise<PinnedPrintSource> {
  const info = await getBaseMapInfo(db, eventId);
  const { hash } = info.document;
  const [row, patch] = await Promise.all([
    db.mapFile.findFirst({ where: { eventId, documentHash: hash }, orderBy: { uploadedAt: "desc" }, select: { rotationCorrection: true } }),
    eventPrintPatch(db, eventId, hash),
  ]);
  return {
    info,
    hash,
    patch,
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

/** `pinnedPrintSource` decoded and patched in this thread (corpus run, in-process tests). */
export async function loadPinnedPrintDocument(db: Db, eventId: bigint): Promise<PinnedPrintDocument> {
  const source = await pinnedPrintSource(db, eventId);
  const document = await prepareDocument(source.hash, source.bytes, source.patch);
  return { info: source.info, document, rotationCorrectionDeg: source.rotationCorrectionDeg };
}
