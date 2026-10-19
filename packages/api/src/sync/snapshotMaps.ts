/**
 * The map part of the venue checkout snapshot (docs/map-storage.md §7.2).
 *
 * The snapshot carries the event's pinned `map_files` rows and the
 * metadata of the `map_sources` / `map_documents` rows they pin, without
 * bytes. The venue then fetches each blob it does not already hold in
 * 4 MiB slices through `lease.exportBlob` and checks size and SHA-256
 * before inserting: sources reach tens of MB, above Cloud Run's 32 MiB
 * response ceiling, so the bytes cannot ride inside the one JSON body.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { getBlob, getBlobSize, type BlobTable } from "../map-store/blob-store.js";
import { SOURCE_SLICE_BYTES, sliceRanges } from "../map-store/source-routes.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Largest slice `lease.exportBlob` returns: the source route's slice. */
export const EXPORT_BLOB_MAX_BYTES = SOURCE_SLICE_BYTES;

export const exportBlobInput = z.object({
  table: z.enum(["map_sources", "map_documents"]),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  start: z.number().int().min(0),
  length: z.number().int().min(1).max(EXPORT_BLOB_MAX_BYTES),
});
export type ExportBlobInput = z.infer<typeof exportBlobInput>;

export interface ExportBlobResult {
  base64: string;
  /** The whole blob's size, so the venue can check it against the manifest. */
  sizeBytes: number;
}

export interface SnapshotMapSource {
  fileHash: string;
  kind: string;
  sizeBytes: number;
  fileName: string;
}

export interface SnapshotMapDocument {
  hash: string;
  sizeBytes: number;
  formatVersion: number;
  importerVersion: string;
  libraryVersion: string;
  sourceHash: string;
  header: unknown;
  report: unknown;
}

export interface SnapshotMaps {
  /** `map_files` rows without `id`, `eventId` and `fileData`. */
  files: Record<string, unknown>[];
  sources: SnapshotMapSource[];
  documents: SnapshotMapDocument[];
  /** `map_files` rows left behind because they have no `source_hash` yet. */
  skipped: number;
}

// ---- pure helpers -----------------------------------------------------------

/** Sorted, distinct hashes the event's pins reference, each document's own source included. */
export function pinnedHashes(
  files: Array<{ sourceHash: string | null; documentHash: string | null }>,
  documentSources: Array<{ hash: string; sourceHash: string }>,
): { sources: string[]; documents: string[] } {
  const sources = new Set<string>();
  const documents = new Set<string>();
  for (const f of files) {
    if (f.sourceHash) sources.add(f.sourceHash);
    if (f.documentHash) documents.add(f.documentHash);
  }
  for (const d of documentSources) if (documents.has(d.hash)) sources.add(d.sourceHash);
  return { sources: [...sources].sort(), documents: [...documents].sort() };
}

/** Rows with a source pin travel (minus local identity); the rest are counted. */
export function partitionMapFiles(rows: Array<Record<string, unknown>>): { files: Record<string, unknown>[]; skipped: number } {
  const files: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const { id: _id, eventId: _eventId, fileData: _fileData, ...rest } of rows) {
    if (rest.sourceHash) files.push(rest);
    else skipped++;
  }
  return { files, skipped };
}

/** The content address is the only identity bytes from the network have. */
export function verifyBlob(table: BlobTable, hash: string, sizeBytes: number, bytes: Uint8Array): void {
  if (bytes.byteLength !== sizeBytes) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Checkout: ${table} ${hash} arrived with ${bytes.byteLength} bytes, expected size ${sizeBytes}.`,
    });
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== hash) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Checkout: ${table} ${hash} arrived with hash ${got}.`,
    });
  }
}

export type BlobSliceFetcher = (table: BlobTable, hash: string, start: number, length: number) => Promise<ExportBlobResult>;

/** Fetch one blob slice by slice and verify the whole. */
export async function fetchBlob(table: BlobTable, hash: string, sizeBytes: number, fetchSlice: BlobSliceFetcher): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const range of sliceRanges(sizeBytes, EXPORT_BLOB_MAX_BYTES)) {
    const length = range.end - range.start + 1;
    const slice = await fetchSlice(table, hash, range.start, length);
    if (slice.sizeBytes !== sizeBytes) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Checkout: the peer reports size ${slice.sizeBytes} for ${table} ${hash}, the snapshot ${sizeBytes}.`,
      });
    }
    const bytes = Buffer.from(slice.base64, "base64");
    if (bytes.length !== length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Checkout: slice ${range.start}+${length} of ${table} ${hash} came back with ${bytes.length} bytes.`,
      });
    }
    parts.push(bytes);
  }
  const whole = Buffer.concat(parts);
  verifyBlob(table, hash, sizeBytes, whole);
  return whole;
}

// ---- exporter (cloud) -------------------------------------------------------

export async function exportSnapshotMaps(db: Db, eventId: bigint): Promise<SnapshotMaps> {
  const rows = await db.mapFile.findMany({
    where: { eventId },
    omit: { fileData: true },
    orderBy: { uploadedAt: "asc" },
  });
  const { files, skipped } = partitionMapFiles(rows as unknown as Array<Record<string, unknown>>);
  const pinned = rows.filter((r) => r.sourceHash !== null);
  const documentHashes = [...new Set(pinned.flatMap((r) => (r.documentHash ? [r.documentHash] : [])))];
  const documents = await db.mapDocument.findMany({
    where: { hash: { in: documentHashes } },
    select: {
      hash: true,
      sizeBytes: true,
      formatVersion: true,
      importerVersion: true,
      libraryVersion: true,
      sourceHash: true,
      header: true,
      report: true,
    },
    orderBy: { hash: "asc" },
  });
  const hashes = pinnedHashes(pinned, documents);
  const sources = await db.mapSource.findMany({
    where: { fileHash: { in: hashes.sources } },
    select: { fileHash: true, kind: true, sizeBytes: true, fileName: true },
    orderBy: { fileHash: "asc" },
  });
  return { files, sources, documents, skipped };
}

/** Whether the event's `map_files` reference the blob — the `lease.exportBlob` gate. */
export async function eventReferencesBlob(db: Db, eventId: bigint, table: BlobTable, hash: string): Promise<boolean> {
  if (table === "map_documents") {
    return (await db.mapFile.count({ where: { eventId, documentHash: hash } })) > 0;
  }
  const n = await db.mapFile.count({
    where: { eventId, OR: [{ sourceHash: hash }, { document: { sourceHash: hash } }] },
  });
  return n > 0;
}

/** `lease.exportBlob`: one slice of a blob the event pins. */
export async function exportBlobSlice(db: Db, eventId: bigint, input: ExportBlobInput): Promise<ExportBlobResult> {
  const sizeBytes = (await eventReferencesBlob(db, eventId, input.table, input.hash))
    ? await getBlobSize(db, input.table, input.hash)
    : null;
  if (sizeBytes === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: `${input.table} ${input.hash} is not pinned by this event.` });
  }
  if (input.start >= sizeBytes) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `start ${input.start} is past the end (${sizeBytes} bytes).` });
  }
  const end = Math.min(input.start + input.length, sizeBytes) - 1;
  const bytes = await getBlob(db, input.table, input.hash, { start: input.start, end });
  if (!bytes) throw new TRPCError({ code: "NOT_FOUND", message: `${input.table} ${input.hash} disappeared.` });
  return { base64: bytes.toString("base64"), sizeBytes };
}

// ---- importer (venue) -------------------------------------------------------

/** `map_files` columns typed `Json?` (schema.prisma). */
const NULLABLE_JSON_FILE_FIELDS = ["bounds", "calibration", "northDetection"] as const;

export interface SnapshotBlobs {
  /** Bytes fetched from the peer, by hash. Blobs the venue already held are absent. */
  sources: Map<string, Buffer>;
  documents: Map<string, Buffer>;
  fetchedBytes: number;
}

/** Fetch every blob of `maps` the venue does not hold yet. Runs before the import transaction. */
export async function fetchSnapshotBlobs(db: Db, maps: SnapshotMaps, fetchSlice: BlobSliceFetcher): Promise<SnapshotBlobs> {
  const out: SnapshotBlobs = { sources: new Map(), documents: new Map(), fetchedBytes: 0 };
  const wanted: Array<{ table: BlobTable; hash: string; sizeBytes: number; into: Map<string, Buffer> }> = [
    ...maps.sources.map((s) => ({ table: "map_sources" as const, hash: s.fileHash, sizeBytes: s.sizeBytes, into: out.sources })),
    ...maps.documents.map((d) => ({ table: "map_documents" as const, hash: d.hash, sizeBytes: d.sizeBytes, into: out.documents })),
  ];
  for (const w of wanted) {
    if ((await getBlobSize(db, w.table, w.hash)) !== null) continue; // append-only: never re-fetched, never rewritten
    w.into.set(w.hash, await fetchBlob(w.table, w.hash, w.sizeBytes, fetchSlice));
    out.fetchedBytes += w.sizeBytes;
  }
  return out;
}

/**
 * Insert the blobs and the event's `map_files` rows inside the snapshot
 * transaction, after the event row. `uploaded_by` and
 * `club_map_version_id` stay NULL: the venue has neither the users nor the
 * club library. `file_data` is the source's bytes.
 */
export async function importSnapshotMaps(
  tx: Prisma.TransactionClient,
  eventId: bigint,
  maps: SnapshotMaps,
  blobs: SnapshotBlobs,
): Promise<{ files: number; sources: number; documents: number }> {
  const newSources = maps.sources.filter((s) => blobs.sources.has(s.fileHash));
  if (newSources.length > 0) {
    await tx.mapSource.createMany({
      data: newSources.map((s) => ({
        fileHash: s.fileHash,
        kind: s.kind,
        bytes: Uint8Array.from(blobs.sources.get(s.fileHash)!),
        sizeBytes: s.sizeBytes,
        fileName: s.fileName,
        uploadedBy: null,
      })),
      skipDuplicates: true,
    });
  }
  const newDocuments = maps.documents.filter((d) => blobs.documents.has(d.hash));
  if (newDocuments.length > 0) {
    await tx.mapDocument.createMany({
      data: newDocuments.map((d) => ({
        hash: d.hash,
        bytes: Uint8Array.from(blobs.documents.get(d.hash)!),
        sizeBytes: d.sizeBytes,
        formatVersion: d.formatVersion,
        importerVersion: d.importerVersion,
        libraryVersion: d.libraryVersion,
        sourceHash: d.sourceHash,
        header: d.header as Prisma.InputJsonValue,
        report: d.report as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }
  for (const f of maps.files) {
    const sourceHash = String(f.sourceHash);
    const fileData = blobs.sources.get(sourceHash) ?? (await getBlob(tx, "map_sources", sourceHash));
    if (!fileData) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Checkout: map source ${sourceHash} is missing on this node.` });
    }
    const row: Record<string, unknown> = { ...f, eventId, fileData: Uint8Array.from(fileData), clubMapVersionId: null };
    // A JSON null arrives as null; Prisma wants the DbNull sentinel for a nullable Json column.
    for (const k of NULLABLE_JSON_FILE_FIELDS) if (row[k] === null) row[k] = Prisma.DbNull;
    await tx.mapFile.create({ data: row as never });
  }
  return { files: maps.files.length, sources: maps.sources.length, documents: maps.documents.length };
}
