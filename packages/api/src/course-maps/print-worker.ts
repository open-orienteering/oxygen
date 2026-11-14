/**
 * Worker-thread body for `maps.pdf` composing (docs/course-print.md §8.2).
 * One long-lived worker per host slot: it decodes the pinned document once
 * per hash (`prepareDocument`'s per-thread cache) and answers print
 * requests strictly one at a time. Messages:
 *
 *   ← { type: "print", id, hash, bytes?, sheets, graphics, … }
 *   → { type: "page", id, index, label, warnings }     after each page
 *   → { type: "done", id, bytes, pageCount, warnings } bytes transferred
 *   ← { type: "raster", id, svg, width, height }       an SVG logo for `print.png` (§8.5)
 *   → { type: "png", id, bytes }                       bytes transferred
 *   → { type: "error", id, message, code? }
 */

import { parentPort } from "node:worker_threads";
import { course } from "@oxygen/shared";
import type { ColourMode } from "@oxygen/shared/print";
import { prepareDocument, type PrintGraphic, type PrintSheet } from "@oxygen/shared/print";
import { rasteriseSvgGraphic, renderCoursePages } from "./pdf-page.js";

export interface PrintWorkerRequest {
  type: "print";
  id: number;
  hash: string;
  /** The document blob; absent when the host believes this worker already holds `hash`. */
  bytes?: Uint8Array;
  sheets: PrintSheet[];
  graphics: Array<[number, PrintGraphic]>;
  rotationCorrectionDeg?: number;
  mode?: ColourMode;
  deterministic?: boolean;
  text?: "font" | "outline";
  info?: { title?: string; author?: string; subject?: string };
}

/** `print.png` (docs/course-print.md §8.5): resvg off the event loop, as the print itself. */
export interface PrintWorkerRasterRequest {
  type: "raster";
  id: number;
  svg: Uint8Array;
  width: number;
  height: number;
}

export type PrintWorkerMessage =
  | { type: "page"; id: number; index: number; label: string; warnings: string[] }
  | { type: "done"; id: number; bytes: Uint8Array; pageCount: number; warnings: string[] }
  | { type: "png"; id: number; bytes: Uint8Array }
  | { type: "error"; id: number; message: string; code?: "CourseStackError" | "NeedDocument" };

class NeedDocument extends Error {}

const port = parentPort;
if (port) {
  const post = (m: PrintWorkerMessage, transfer: ArrayBuffer[] = []) => port.postMessage(m, transfer);
  let queue: Promise<void> = Promise.resolve();

  const handle = async (req: PrintWorkerRequest): Promise<void> => {
    try {
      const document = await prepareDocument(req.hash, () => {
        if (!req.bytes) throw new NeedDocument();
        return req.bytes;
      });
      const out = await renderCoursePages({
        document,
        sheets: req.sheets,
        graphics: new Map(req.graphics),
        rotationCorrectionDeg: req.rotationCorrectionDeg,
        mode: req.mode,
        deterministic: req.deterministic,
        text: req.text,
        info: req.info,
        onPage: (p) => post({ type: "page", id: req.id, ...p }),
      });
      // A slice of a larger buffer cannot be transferred whole: copy only then.
      const bytes = out.bytes.byteOffset === 0 && out.bytes.byteLength === out.bytes.buffer.byteLength ? out.bytes : out.bytes.slice();
      post({ type: "done", id: req.id, bytes, pageCount: out.pageCount, warnings: out.warnings }, [bytes.buffer as ArrayBuffer]);
    } catch (err) {
      if (err instanceof NeedDocument) post({ type: "error", id: req.id, message: "document not prepared", code: "NeedDocument" });
      else post({ type: "error", id: req.id, message: err instanceof Error ? err.message : String(err), ...(err instanceof course.CourseStackError ? { code: "CourseStackError" as const } : {}) });
    }
  };

  const raster = async (req: PrintWorkerRasterRequest): Promise<void> => {
    try {
      const png = await rasteriseSvgGraphic(req.svg, req.width, req.height);
      const bytes = png.byteOffset === 0 && png.byteLength === png.buffer.byteLength ? png : png.slice();
      post({ type: "png", id: req.id, bytes }, [bytes.buffer as ArrayBuffer]);
    } catch (err) {
      post({ type: "error", id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  };

  port.on("message", (req: PrintWorkerRequest | PrintWorkerRasterRequest) => {
    if (req.type === "print") queue = queue.then(() => handle(req));
    else if (req.type === "raster") queue = queue.then(() => raster(req));
  });
}
