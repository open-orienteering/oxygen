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
  type PreparedDocument,
  type PrintPatch,
  renderCoursePages as renderSharedCoursePages,
  prepareDocument,
} from "@oxygen/shared/print";
import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { getBlob } from "../map-store/blob-store.js";
import { eventPrintPatch } from "../map-store/patches.js";
import { BUNDLED_FONT_FILES, bundledPrintFonts } from "../render/fonts.js";
import { type BaseMapInfo, getBaseMapInfo } from "./map-source.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The shared options less what this binding supplies: the bundled fonts and the yield; `rasteriseSvg` defaults to resvg. */
export type CoursePagesOptions = Omit<SharedCoursePagesOptions, "fonts" | "yieldToHost">;

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

/** One page at a time on the event loop: other requests (card readouts) run between pages of a long export (course-print.md §8.2). */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Every sheet as one page of one PDF (the shared `renderCoursePages` with
 * the bundled fonts, resvg and the event-loop yield). Throws
 * `course.CourseStackError` for a document whose colour stack is not
 * aligned.
 */
export async function renderCoursePages(opts: CoursePagesOptions): Promise<CoursePagesResult> {
  return renderSharedCoursePages({ ...opts, fonts: await bundledPrintFonts(), rasteriseSvg: opts.rasteriseSvg ?? rasteriseSvgGraphic, yieldToHost: yieldToEventLoop });
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
