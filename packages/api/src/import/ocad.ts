/**
 * Map file → map document (docs/map-import.md, stages 3–8 of 06 §4.1:
 * parse, normalise, match + align, encode, hash), for both source kinds.
 *
 * OCAD is read by the fork's `ocad2geojson`; Mapper XML by the shared
 * `readOmap`. Everything after the reader is the shared, isomorphic
 * normaliser, matcher and codec. This module adds only the Node pieces:
 * dynamic import of the OCAD reader, SHA-256 via `node:crypto`, and the
 * dispatch on the sniffed source kind.
 */

import { createHash } from "node:crypto";
import { mapDocument, mapImport, symbolLibrary } from "@oxygen/shared";

type ReadOcad = (buf: Buffer, opts?: Record<string, unknown>) => Promise<mapImport.OcadFileLike>;

let readOcadPromise: Promise<ReadOcad> | undefined;
async function loadReader(): Promise<ReadOcad> {
  readOcadPromise ??= import("ocad2geojson").then((m) => (m as Record<string, unknown>).readOcad as ReadOcad);
  return readOcadPromise;
}

export type MapSourceKind = "ocad" | "omap";

export interface MapImportResult {
  /** The encoded document. */
  bytes: Uint8Array;
  /** SHA-256 hex of `bytes` — the document's identity. */
  documentHash: string;
  /** SHA-256 hex of the source file. */
  fileHash: string;
  counts: mapImport.OcadSourceResult["counts"];
  warnings: mapImport.OcadSourceResult["warnings"];
  /** Which reader produced the document. */
  kind: MapSourceKind;
  /** Stage 6–7 summaries (docs/map-symbols.md §9). */
  matching: mapImport.MatchingSummary;
  colourStack: mapImport.ColourStackSummary;
  /** Stage 5 (docs/map-import.md §3.8): georeference and north lines; not part of the document. */
  analysis: mapImport.DocumentAnalysis;
  /** `<library id>@<library version>` — part of the document's identity for dedup. */
  libraryVersion: string;
  timings: { read: number; normalise: number; match: number; encode: number };
}

/** Kept for existing callers; the result shape is the same for both kinds. */
export type OcadImportResult = MapImportResult;

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Import stages as reported to a job row (docs/map-import.md §1). */
export type ImportStage = "parse" | "normalise" | "match" | "encode";

/** The library version string stored on `map_documents.library_version` (docs/map-storage.md §3). */
export function documentLibraryVersion(libraryId: string): string {
  return `${libraryId}@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`;
}

/** The importer version string a source kind's documents carry (`format.importer`); the dedup key with the library version. */
export function importerVersionFor(kind: MapSourceKind): string {
  return kind === "omap" ? mapImport.OMAP_IMPORTER_VERSION : mapImport.OCAD_IMPORTER_VERSION;
}
export const IMPORTER_VERSIONS: readonly string[] = [mapImport.OCAD_IMPORTER_VERSION, mapImport.OMAP_IMPORTER_VERSION];

export interface ImportOptions {
  onStage?: (stage: ImportStage) => void;
  match?: mapImport.MatchDocumentOptions;
  importer?: string;
}

/** Stages 3–4 for one source kind: parse the file and normalise it to a `MapDocumentInput`. */
async function readAndNormalise(
  file: Buffer,
  fileName: string,
  kind: MapSourceKind,
  fileHash: string,
  opts: ImportOptions & Pick<mapImport.OcadSourceOptions, "renderFor">,
): Promise<{ source: mapImport.OcadSourceResult; read: number; normalise: number }> {
  const base = { fileName, fileHash, fileBytes: file.byteLength, importer: opts.importer };
  if (kind === "omap") {
    opts.onStage?.("parse");
    let t = performance.now();
    const omap = mapImport.readOmap(file.toString("utf8"));
    const read = performance.now() - t;
    opts.onStage?.("normalise");
    t = performance.now();
    const source = mapImport.omapToDocumentInput(omap, base);
    return { source, read, normalise: performance.now() - t };
  }
  const readOcad = await loadReader();
  opts.onStage?.("parse");
  let t = performance.now();
  const ocad = await readOcad(file, { quietWarnings: true });
  const read = performance.now() - t;
  opts.onStage?.("normalise");
  t = performance.now();
  const source = mapImport.ocadToDocumentInput(ocad, { ...base, renderFor: opts.renderFor });
  return { source, read, normalise: performance.now() - t };
}

/** Stages 3–8 for a file of a known kind (see `sniffMapKind` in `map-store/uploads.ts`). */
export async function importMapToDocument(
  file: Buffer,
  fileName: string,
  kind: MapSourceKind,
  opts: ImportOptions & Pick<mapImport.OcadSourceOptions, "renderFor"> = {},
): Promise<MapImportResult> {
  const { onStage, match: matchOpts } = opts;
  const fileHash = sha256Hex(file);
  const { source: { input: sourceInput, counts, warnings, analysis }, read, normalise } = await readAndNormalise(file, fileName, kind, fileHash, opts);
  onStage?.("match");
  let t = performance.now();
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
    kind,
    counts,
    warnings: [...warnings, ...matched.warnings.map((w) => ({ code: w.code, count: w.count, message: w.message }))],
    matching: matched.matching,
    colourStack: matched.colourStack,
    analysis,
    libraryVersion: documentLibraryVersion(matched.matching.library.id),
    timings: { read, normalise, match, encode },
  };
}

/** OCAD-only entry point (existing callers and the `renderFor` pilot hook). */
export function importOcadToDocument(
  file: Buffer,
  fileName: string,
  opts: ImportOptions & Pick<mapImport.OcadSourceOptions, "renderFor"> = {},
): Promise<MapImportResult> {
  return importMapToDocument(file, fileName, "ocad", opts);
}

/** Mapper (`.omap` / `.xmap`) entry point. */
export function importOmapToDocument(file: Buffer, fileName: string, opts: ImportOptions = {}): Promise<MapImportResult> {
  return importMapToDocument(file, fileName, "omap", opts);
}
