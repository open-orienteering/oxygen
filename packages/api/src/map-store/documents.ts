/**
 * Stage 9 of the import (docs/map-import.md §1, docs/map-storage.md §3):
 * persist a source file and its imported document as content-addressed,
 * immutable rows. Both inserts are `ON CONFLICT DO NOTHING`, so storing
 * the same bytes twice — two events uploading one club file, or a job
 * re-run after a stale heartbeat — is a no-op that reports `deduplicated`.
 */

import { mapDocument, mapImport } from "@oxygen/shared";
import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { importOcadToDocument, type OcadImportResult } from "../import/ocad.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Documents imported before the matcher landed (slice A step 6) carry this library version. */
export const LIBRARY_VERSION_NONE = "none";

export interface StoreDocumentInput {
  source: { bytes: Uint8Array; fileHash: string; kind: "ocad" | "omap"; fileName: string; uploadedBy?: string | null };
  document: { bytes: Uint8Array; hash: string; libraryVersion?: string };
  report: mapImport.ImportReport;
}

export interface StoreDocumentResult {
  sourceHash: string;
  documentHash: string;
  /** True when the document row already existed. */
  deduplicated: boolean;
}

/**
 * The document header as stored in `map_documents.header`: everything
 * except the symbol table and the string table, which can be large and
 * are read from the document itself when needed. Counts stand in.
 */
export function documentHeaderSummary(header: mapDocument.MapDocumentHeader): Record<string, unknown> {
  const { symbols, strings, ...rest } = header;
  return { ...rest, symbolCount: symbols.length, stringCount: strings.length };
}

export function buildImportReport(result: OcadImportResult, header: mapDocument.MapDocumentHeader, fileName: string): mapImport.ImportReport {
  return mapImport.importReportSchema.parse({
    importer: header.format.importer,
    source: { kind: header.source.kind, version: header.source.version, fileName, bytes: header.source.bytes, fileHash: header.source.hash },
    counts: result.counts,
    warnings: result.warnings,
    matching: result.matching,
    colourStack: result.colourStack,
    timings: result.timings,
  });
}

export async function storeImportedDocument(db: Db, input: StoreDocumentInput): Promise<StoreDocumentResult> {
  const { header } = mapDocument.readMapDocumentHeader(input.document.bytes);
  if (header.source.hash !== input.source.fileHash) {
    throw new Error(`document ${input.document.hash} was imported from ${header.source.hash}, not ${input.source.fileHash}`);
  }
  await db.mapSource.createMany({
    data: [{
      fileHash: input.source.fileHash,
      kind: input.source.kind,
      bytes: Uint8Array.from(input.source.bytes),
      sizeBytes: input.source.bytes.byteLength,
      fileName: input.source.fileName,
      uploadedBy: input.source.uploadedBy ?? null,
    }],
    skipDuplicates: true,
  });
  const inserted = await db.mapDocument.createMany({
    data: [{
      hash: input.document.hash,
      bytes: Uint8Array.from(input.document.bytes),
      sizeBytes: input.document.bytes.byteLength,
      formatVersion: header.format.version,
      importerVersion: header.format.importer,
      libraryVersion: input.document.libraryVersion ?? LIBRARY_VERSION_NONE,
      sourceHash: input.source.fileHash,
      header: documentHeaderSummary(header) as Prisma.InputJsonValue,
      report: input.report as unknown as Prisma.InputJsonValue,
    }],
    skipDuplicates: true,
  });
  return { sourceHash: input.source.fileHash, documentHash: input.document.hash, deduplicated: inserted.count === 0 };
}

/** Import an OCAD file and store source + document. The whole stage-3-to-9 path for one upload. */
export async function importAndStoreOcad(
  db: Db,
  file: Buffer,
  fileName: string,
  opts: { uploadedBy?: string | null } = {},
): Promise<StoreDocumentResult & { report: mapImport.ImportReport; result: OcadImportResult }> {
  const result = await importOcadToDocument(file, fileName);
  const { header } = mapDocument.readMapDocumentHeader(result.bytes);
  const report = buildImportReport(result, header, fileName);
  const stored = await storeImportedDocument(db, {
    source: { bytes: file, fileHash: result.fileHash, kind: "ocad", fileName, uploadedBy: opts.uploadedBy },
    document: { bytes: result.bytes, hash: result.documentHash, libraryVersion: result.libraryVersion },
    report,
  });
  return { ...stored, report, result };
}

/** Mark a document as referenced (GC input). */
export async function touchDocument(db: Db, hash: string): Promise<void> {
  await db.mapDocument.updateMany({ where: { hash }, data: { lastReferencedAt: new Date() } });
}
