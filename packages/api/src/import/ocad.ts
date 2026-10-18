/**
 * OCAD file → map document (docs/map-import.md, stages 3–8 of 06 §4.1:
 * parse, normalise, match + align, encode, hash).
 *
 * The reader is the fork's `ocad2geojson`; everything after it is the
 * shared, isomorphic normaliser and codec. This module adds only the
 * Node pieces: dynamic import of the reader, SHA-256 via `node:crypto`.
 */

import { createHash } from "node:crypto";
import { mapDocument, mapImport, symbolLibrary } from "@oxygen/shared";

type ReadOcad = (buf: Buffer, opts?: Record<string, unknown>) => Promise<mapImport.OcadFileLike>;

let readOcadPromise: Promise<ReadOcad> | undefined;
async function loadReader(): Promise<ReadOcad> {
  readOcadPromise ??= import("ocad2geojson").then((m) => (m as Record<string, unknown>).readOcad as ReadOcad);
  return readOcadPromise;
}

export interface OcadImportResult {
  /** The encoded document. */
  bytes: Uint8Array;
  /** SHA-256 hex of `bytes` — the document's identity. */
  documentHash: string;
  /** SHA-256 hex of the source file. */
  fileHash: string;
  counts: mapImport.OcadSourceResult["counts"];
  warnings: mapImport.OcadSourceResult["warnings"];
  /** Stage 6–7 summaries (docs/map-symbols.md §9). */
  matching: mapImport.MatchingSummary;
  colourStack: mapImport.ColourStackSummary;
  /** `<library id>@<library version>` — part of the document's identity for dedup. */
  libraryVersion: string;
  timings: { read: number; normalise: number; match: number; encode: number };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Import stages as reported to a job row (docs/map-import.md §1). */
export type ImportStage = "parse" | "normalise" | "match" | "encode";

/** The library version string stored on `map_documents.library_version` (docs/map-storage.md §3). */
export function documentLibraryVersion(libraryId: string): string {
  return `${libraryId}@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`;
}

export async function importOcadToDocument(
  file: Buffer,
  fileName: string,
  opts: Pick<mapImport.OcadSourceOptions, "importer" | "renderFor"> & { onStage?: (stage: ImportStage) => void; match?: mapImport.MatchDocumentOptions } = {},
): Promise<OcadImportResult> {
  const { onStage, match: matchOpts, ...sourceOpts } = opts;
  const readOcad = await loadReader();
  onStage?.("parse");
  let t = performance.now();
  const ocad = await readOcad(file, { quietWarnings: true });
  const read = performance.now() - t;
  const fileHash = sha256Hex(file);
  onStage?.("normalise");
  t = performance.now();
  const { input: sourceInput, counts, warnings } = mapImport.ocadToDocumentInput(ocad, { fileName, fileHash, fileBytes: file.byteLength, ...sourceOpts });
  const normalise = performance.now() - t;
  onStage?.("match");
  t = performance.now();
  const matched = mapImport.matchDocument(sourceInput, matchOpts);
  const match = performance.now() - t;
  onStage?.("encode");
  t = performance.now();
  const bytes = mapDocument.encodeMapDocument(matched.input);
  const encode = performance.now() - t;
  return {
    bytes,
    documentHash: sha256Hex(bytes),
    fileHash,
    counts,
    warnings: [...warnings, ...matched.warnings.map((w) => ({ code: w.code, count: w.count, message: w.message }))],
    matching: matched.matching,
    colourStack: matched.colourStack,
    libraryVersion: documentLibraryVersion(matched.matching.library.id),
    timings: { read, normalise, match, encode },
  };
}
