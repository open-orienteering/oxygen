/**
 * A Prisma stand-in for the document readers' unit tests
 * (`map-store/event-document.ts` and its callers): one event's latest
 * `map_files` row, `map_documents` rows with their header summary and
 * report, and the two blob tables `getBlob` reads with raw SQL. Built from
 * an in-memory import (`importOcadToDocument`), so the readers run on
 * exactly what the import job would store.
 */

import { mapDocument } from "@oxygen/shared";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { importMapToDocument } from "../../import/ocad.js";
import { buildImportReport, documentHeaderSummary } from "../../map-store/documents.js";

export interface StubDocument {
  hash: string;
  sourceHash: string;
  bytes: Uint8Array;
  header: unknown;
  report: unknown;
}

export interface StubPin {
  documentHash: string | null;
  sourceHash: string | null;
  rotationCorrection?: number;
}

export interface StubDb {
  db: PrismaClient;
  /** How often each table was read, for cache assertions. */
  reads: { mapFile: number; mapDocument: number; blobs: number };
  setPin(pin: StubPin | null): void;
}

/** Import a source file in memory and return what `storeImportedDocument` would write. */
export async function importForStub(bytes: Buffer, fileName: string, kind: "ocad" | "omap" = "ocad", asOf = new Date("2026-11-05T00:00:00Z")): Promise<StubDocument> {
  const result = await importMapToDocument(bytes, fileName, kind);
  const { header } = mapDocument.readMapDocumentHeader(result.bytes);
  return {
    hash: result.documentHash,
    sourceHash: result.fileHash,
    bytes: result.bytes,
    header: documentHeaderSummary(header),
    report: buildImportReport(result, header, fileName, asOf),
  };
}

export function documentDbStub(documents: StubDocument[], sources: Record<string, Uint8Array>, pin: StubPin | null): StubDb {
  let current = pin;
  const reads = { mapFile: 0, mapDocument: 0, blobs: 0 };
  const byHash = new Map(documents.map((d) => [d.hash, d]));
  const db = {
    mapFile: {
      findFirst: async () => {
        reads.mapFile++;
        if (!current) return null;
        return {
          id: 1n,
          fileName: "map.ocd",
          uploadedAt: new Date("2026-11-01T00:00:00Z"),
          documentHash: current.documentHash,
          sourceHash: current.sourceHash,
          clubMapVersionId: null,
          rotationCorrection: current.rotationCorrection ?? 0,
          scale: null,
          bounds: null,
          northOffset: null,
          calibration: null,
        };
      },
    },
    mapDocument: {
      findUnique: async ({ where }: { where: { hash: string } }) => {
        reads.mapDocument++;
        const d = byHash.get(where.hash);
        return d ? { header: d.header, report: d.report, sourceHash: d.sourceHash } : null;
      },
    },
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      reads.blobs++;
      const hash = args[args.length - 1] as string;
      const bytes = sql.includes("map_sources") ? sources[hash] : byHash.get(hash)?.bytes;
      if (!bytes) return [];
      const buf = Buffer.from(bytes);
      if (args.length === 3) {
        const [from, length] = args as [number, number];
        return [{ chunk: buf.subarray(from - 1, from - 1 + length) }];
      }
      return [{ chunk: buf }];
    },
  };
  return { db: db as unknown as PrismaClient, reads, setPin: (p) => { current = p; } };
}
