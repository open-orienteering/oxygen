/**
 * Worker-thread body for one height-field derive (docs/map-storage.md
 * §4.7): decode the document, `deriveTerrain(doc)` with the defaults
 * (docs/map-terrain.md §5.5), encode. The host owns the row; this thread
 * only computes, so a 15 s derive never holds the Fastify event loop.
 *
 *   → { type: "done", bytes, header, report }   the encoded field
 *   → { type: "none" }                          the document has no contours
 *   → { type: "error", message }
 */

import { parentPort, workerData } from "node:worker_threads";
import { mapDocument } from "@oxygen/shared";
import { deriveTerrain } from "@oxygen/shared/src/terrain/index.js";
import { encodeHeightField, type HeightFieldHeader } from "@oxygen/shared/src/terrain/field/index.js";
import type { TerrainReport } from "@oxygen/shared/src/terrain/solve/index.js";

export interface HeightfieldWorkerData {
  /** The encoded map document. */
  bytes: Uint8Array;
}

export type HeightfieldWorkerMessage =
  | { type: "done"; bytes: Uint8Array; header: HeightFieldHeader; report: TerrainReport }
  | { type: "none" }
  | { type: "error"; message: string };

/** The derive itself, apart from the thread plumbing (also the unit tests' oracle). */
export function deriveHeightfieldBytes(bytes: Uint8Array): Exclude<HeightfieldWorkerMessage, { type: "error" }> {
  const doc = mapDocument.decodeMapDocument(bytes);
  const derived = deriveTerrain(doc);
  if (!derived) return { type: "none" };
  return { type: "done", bytes: encodeHeightField(derived.field), header: derived.field.header, report: derived.report };
}

const port = parentPort;
if (port && (workerData as Partial<HeightfieldWorkerData> | null)?.bytes) {
  const { bytes } = workerData as HeightfieldWorkerData;
  try {
    const m = deriveHeightfieldBytes(bytes);
    if (m.type === "done") port.postMessage(m, [m.bytes.buffer as ArrayBuffer]);
    else port.postMessage(m);
  } catch (err: unknown) {
    port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies HeightfieldWorkerMessage);
  }
}
