/**
 * The print worker's messages (docs/course-print.md §8.6, G16). All
 * structured-cloneable; byte payloads are transferred. Types only: the
 * main thread imports this without reaching `@oxygen/shared/print`.
 *
 *   → init      { faces }                once per worker: the bundled faces, regular, narrow, bold
 *   → compose   { id, job, deterministic? }
 *   ← need      { id, reqId, what: "document", hash } | { id, reqId, what: "graphic", graphicId, box? }
 *   → reply     { reqId, bytes } | { reqId, error }
 *   ← page      { id, index, label, warnings }
 *   ← done      { id, bytes, pageCount, warnings }
 *   ← error     { id, message }
 *
 * The worker asks for the document only when its `prepareDocument` cache
 * lacks the hash, a PNG graphic once without a box and an SVG once per
 * pixel box (`print.png?w=&h=`); the main thread owns every request.
 */

import type { render } from "@oxygen/shared";
import type { PrintJob } from "@oxygen/shared/print";

export interface PrintFace {
  family: render.FontFamily;
  data: ArrayBuffer;
}

export type PrintWorkerRequest =
  | { type: "init"; faces: PrintFace[] }
  | { type: "compose"; id: number; job: PrintJob; deterministic?: boolean }
  | { type: "reply"; reqId: number; bytes: ArrayBuffer }
  | { type: "reply"; reqId: number; error: string };

export type PrintWorkerNeed =
  | { type: "need"; id: number; reqId: number; what: "document"; hash: string }
  | { type: "need"; id: number; reqId: number; what: "graphic"; graphicId: number; box?: [number, number] };

export type PrintWorkerResponse =
  | PrintWorkerNeed
  | { type: "page"; id: number; index: number; label: string; warnings: string[] }
  | { type: "done"; id: number; bytes: ArrayBuffer; pageCount: number; warnings: string[] }
  | { type: "error"; id: number; message: string };
