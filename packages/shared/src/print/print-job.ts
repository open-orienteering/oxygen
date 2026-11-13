/**
 * The print job (docs/course-print.md §8.5, G15): what `maps.pdf` hands
 * its print worker, less the bytes, as JSON — and `renderPrintJob`, the
 * one entry that composes it on any host. The API's
 * `GET /api/maps/:nameId/print-job` answers the job; the browser's Web
 * Worker (G16) and the API's byte-identity test compose it here, so a job
 * composed anywhere gives the server's bytes (slice G answer 3; equal
 * writer options, §8.5).
 *
 * Isomorphic (§1): the document, the fonts and the graphics arrive through
 * the host. The browser never rasterises SVG: an SVG graphic is asked from
 * the host by id at the pixel box the composer computes (`svgRasterBox`),
 * which the server's `print.png` serves.
 */

import type { ColourMode } from "./colour.js";
import { type CoursePagesOptions, type CoursePagesResult, type PrintFonts, type PrintGraphic, type PrintSheet, renderCoursePages } from "./course-pages.js";
import { prepareDocument } from "./prepared-document.js";

/** The job format a host composes; another version is refused (G14 adds the patch). */
export const PRINT_JOB_VERSION = 1;

export type PrintJobGraphicMime = "image/png" | "image/svg+xml";

export interface PrintJob {
  version: typeof PRINT_JOB_VERSION;
  /** The pinned document by hash (`GET /api/map-documents/:hash`) and its `map_files.rotation_correction`. */
  document: { hash: string; rotationCorrectionDeg: number };
  /** The resolved sheets, in print order, each with its copies (§4.5). */
  sheets: PrintSheet[];
  /** Every graphic a sheet's image objects reference that exists, ascending id. */
  graphics: { id: number; mime: PrintJobGraphicMime }[];
  /** Always `cmyk` from the route (§8.2). */
  mode: ColourMode;
  info: { title: string; author?: string };
  /** `maps.pdf`'s download name (§8.3). */
  filename: string;
}

export interface PrintJobHost {
  /** The document's bytes (`prepareDocument`'s loader; not called when this thread holds the hash). */
  document(hash: string): Promise<Uint8Array> | Uint8Array;
  /** The bundled faces in the order regular, narrow, bold (§8.5). */
  fonts: PrintFonts;
  /** A graphic's PNG: as stored for a PNG (no box), rasterised at `box` for an SVG (`print.png?w=&h=`). */
  graphic(id: number, box?: [widthPx: number, heightPx: number]): Promise<Uint8Array>;
  deterministic?: boolean;
  yieldToHost?: CoursePagesOptions["yieldToHost"];
  onPage?: CoursePagesOptions["onPage"];
}

/**
 * Compose a print job into one PDF. PNG graphics are fetched up front; a
 * PNG the host cannot fetch is left out (the writer's `IMAGE_MISSING`), an
 * SVG it cannot fetch gives `SVG_RASTER` — the PDF is still written, as on
 * the server. Throws for another job version and, like `maps.pdf`,
 * `course.CourseStackError` for a document whose colour stack is not aligned.
 */
export async function renderPrintJob(job: PrintJob, host: PrintJobHost): Promise<CoursePagesResult> {
  if (job.version !== PRINT_JOB_VERSION) throw new Error(`Unsupported print job version ${String(job.version)}`);
  const document = await prepareDocument(job.document.hash, () => host.document(job.document.hash));
  const graphics = new Map<number, PrintGraphic>();
  const empty = new Uint8Array(0);
  await Promise.all(
    job.graphics.map(async ({ id, mime }) => {
      if (mime === "image/svg+xml") {
        // The bytes are never needed here: `rasteriseSvg` asks the host by id.
        graphics.set(id, { mime, data: empty });
        return;
      }
      try {
        graphics.set(id, { mime, data: await host.graphic(id) });
      } catch {
        // Absent: the writer reports IMAGE_MISSING for the page.
      }
    }),
  );
  return renderCoursePages({
    document,
    rotationCorrectionDeg: job.document.rotationCorrectionDeg,
    sheets: job.sheets,
    fonts: host.fonts,
    graphics,
    mode: job.mode,
    deterministic: host.deterministic,
    info: job.info,
    rasteriseSvg: (_svg, w, h, id) => host.graphic(id, [w, h]),
    yieldToHost: host.yieldToHost,
    onPage: host.onPage,
  });
}
