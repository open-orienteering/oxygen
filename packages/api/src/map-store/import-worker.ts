/**
 * Worker-thread body for one map import (docs/map-storage.md §6.2).
 * Stages 3–8 run here so the Fastify event loop stays free; the parent
 * stores the result (stage 9) and owns the job row. Messages:
 *
 *   → { type: "stage", stage }                       at each stage boundary
 *   → { type: "done", bytes, documentHash, fileHash, report }
 *   → { type: "error", message }
 */

import { parentPort, workerData } from "node:worker_threads";
import { mapDocument, type mapImport } from "@oxygen/shared";
import { importMapToDocument, type ImportStage, type MapSourceKind } from "../import/ocad.js";
import { buildImportReport } from "./documents.js";

export interface ImportWorkerData {
  bytes: Uint8Array;
  fileName: string;
  kind: MapSourceKind;
  /** The job's decision snapshot, applied by stage 6 (docs/map-symbols.md §8.5). */
  decisions?: mapImport.SymbolDecision[];
}

export type ImportWorkerMessage =
  | { type: "stage"; stage: ImportStage }
  | { type: "done"; bytes: Uint8Array; documentHash: string; fileHash: string; libraryVersion: string; report: ReturnType<typeof buildImportReport> }
  | { type: "error"; message: string };

const port = parentPort;
if (port) {
  const { bytes, fileName, kind, decisions } = workerData as ImportWorkerData;
  const post = (m: ImportWorkerMessage) => port.postMessage(m);
  (async () => {
    const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await importMapToDocument(file, fileName, kind ?? "ocad", { onStage: (stage) => post({ type: "stage", stage }), match: { decisions: decisions ?? [] } });
    const { header } = mapDocument.readMapDocumentHeader(result.bytes);
    const report = buildImportReport(result, header, fileName);
    post({ type: "done", bytes: result.bytes, documentHash: result.documentHash, fileHash: result.fileHash, libraryVersion: result.libraryVersion, report });
  })().catch((err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
}
