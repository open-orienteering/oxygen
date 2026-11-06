/**
 * Server reads of the event's pinned map document (docs/map-storage.md
 * §4.6). Every reader that once parsed the OCAD bytes in
 * `map_files.file_data` — the event CRS, the description autodetect's
 * objects, cut features, check obstacles, north, the print's scale and
 * tilt, `course.mapMetadata` — reads through these helpers instead.
 *
 * The pin is the latest `map_files` row's `document_hash`, for every
 * event (the per-event switch is retired, docs/map-pipeline-switch.md).
 * No pin → the honest "no map" answer (null), never an OCAD parse.
 *
 * Caches are keyed by document or source hash. Both are content-addressed,
 * so an entry is never stale and nothing has to bump `uploaded_at` to
 * invalidate it.
 */

import { mapDocument, mapGeo, mapImport } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { LruCache } from "../course-maps/lru-cache.js";
import { frameFromOcadCrs, type OcadCrs } from "../map-projection.js";
import { getBlob } from "./blob-store.js";
import { documentFrameSchema, mapFileMetadataFor, type DocumentFrame } from "./map-file-metadata.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The latest `map_files` row of an event: what the readers need of it. */
export interface EventPin {
  id: bigint;
  fileName: string;
  uploadedAt: Date;
  documentHash: string | null;
  sourceHash: string | null;
  clubMapVersionId: string | null;
  rotationCorrection: number;
  scale: number | null;
  bounds: Prisma.JsonValue;
  northOffset: number | null;
  calibration: Prisma.JsonValue;
  colorProfile: string;
  colorOverrides: Prisma.JsonValue;
  northLinesBelow: boolean;
  renderKey: string | null;
}

const PIN_SELECT = {
  id: true,
  fileName: true,
  uploadedAt: true,
  documentHash: true,
  sourceHash: true,
  clubMapVersionId: true,
  rotationCorrection: true,
  scale: true,
  bounds: true,
  northOffset: true,
  calibration: true,
  colorProfile: true,
  colorOverrides: true,
  northLinesBelow: true,
  renderKey: true,
} as const;

/** The event's latest `map_files` row (never its bytes), or null when no map was uploaded. */
export async function eventPin(db: Db, eventId: bigint): Promise<EventPin | null> {
  return db.mapFile.findFirst({ where: { eventId }, orderBy: { uploadedAt: "desc" }, select: PIN_SELECT });
}

/** The event's pinned document hash, or null (no map, or the import has not pinned yet). */
export async function eventDocumentHash(db: Db, eventId: bigint): Promise<string | null> {
  const row = await db.mapFile.findFirst({ where: { eventId }, orderBy: { uploadedAt: "desc" }, select: { documentHash: true } });
  return row?.documentHash ?? null;
}

/** A document's frame from its stored header summary, plus the source it was imported from. */
export interface StoredDocumentFrame {
  frame: DocumentFrame;
  sourceHash: string;
}

const frames = new LruCache<StoredDocumentFrame | null>(32);
const norths = new LruCache<{ north: mapImport.ImportReport["north"] | null }>(32);
const decoded = new LruCache<mapDocument.MapDocument>(3);
const sourceFrames = new LruCache<{ frame: mapGeo.PaperFrame | null }>(8);

/** The header fields the CRS needs, from `map_documents.header`; null when the row is missing or does not parse. */
export async function documentFrame(db: Db, hash: string): Promise<StoredDocumentFrame | null> {
  const cached = frames.get(hash);
  if (cached !== undefined) return cached;
  const row = await db.mapDocument.findUnique({ where: { hash }, select: { header: true, sourceHash: true } });
  const parsed = row ? documentFrameSchema.safeParse(row.header) : null;
  if (row && !parsed?.success) console.warn(`[event-document] document ${hash}: header does not parse:`, parsed?.error?.message);
  const result = row && parsed?.success ? { frame: parsed.data, sourceHash: row.sourceHash } : null;
  if (row) frames.set(hash, result);
  return result;
}

/**
 * The `north` section of a stored import report, parsed on its own so a
 * report from an older importer that fails elsewhere still yields it;
 * null when absent or unparseable.
 */
export function reportNorth(report: unknown): mapImport.ImportReport["north"] | null {
  const north = report && typeof report === "object" ? (report as { north?: unknown }).north : undefined;
  const parsed = mapImport.importReportSchema.shape.north.safeParse(north);
  return parsed.success ? (parsed.data ?? null) : null;
}

/** The stage-5 north analysis (`report.north`, `detectDocumentNorth`); null when absent or unparseable. */
export async function documentNorth(db: Db, hash: string): Promise<mapImport.ImportReport["north"] | null> {
  const cached = norths.get(hash);
  if (cached) return cached.north;
  const row = await db.mapDocument.findUnique({ where: { hash }, select: { report: true } });
  if (!row) return null;
  const north = reportNorth(row.report);
  norths.set(hash, { north });
  return north;
}

/** The whole decoded document; null when the blob is missing or does not decode (logged). */
export async function decodedDocument(db: Db, hash: string): Promise<mapDocument.MapDocument | null> {
  const cached = decoded.get(hash);
  if (cached) return cached;
  const bytes = await getBlob(db, "map_documents", hash);
  if (!bytes) return null;
  try {
    const doc = mapDocument.decodeMapDocument(bytes);
    decoded.set(hash, doc);
    return doc;
  } catch (err) {
    console.warn(`[event-document] document ${hash} unreadable:`, err);
    return null;
  }
}

/**
 * The one read of `map_sources.bytes` (docs/map-storage.md §4.6): a
 * document whose header has `crs: null` (`CRS_UNRESOLVED` — the ScalePar
 * grid id is not in the reader's table) gets the legacy coordinate-range
 * inference of the OCAD reader's ScalePar (`getEpsgString`), so such maps
 * keep the CRS they had before the move. Null when that finds none too.
 */
export async function sourceFrameFallback(db: Db, sourceHash: string): Promise<mapGeo.PaperFrame | null> {
  const cached = sourceFrames.get(sourceHash);
  if (cached) return cached.frame;
  let frame: mapGeo.PaperFrame | null = null;
  try {
    const bytes = await getBlob(db, "map_sources", sourceHash);
    if (bytes) {
      const ocadMod = await import("ocad2geojson");
      const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
        buf: Buffer,
        opts?: Record<string, unknown>,
      ) => Promise<{ getCrs(): OcadCrs }>;
      frame = frameFromOcadCrs((await readOcad(bytes, { quietWarnings: true })).getCrs());
    }
  } catch (err) {
    // Not an OCAD source (OMAP has no range inference) or unreadable: no CRS.
    console.warn(`[event-document] source ${sourceHash}: no CRS fallback:`, err instanceof Error ? err.message : err);
  }
  sourceFrames.set(sourceHash, { frame });
  return frame;
}

/**
 * The paper frame of a stored document with `correctionDeg` applied; null
 * only when the document row is missing or its header does not parse. A
 * header with `crs: null` takes the source fallback when that finds one;
 * otherwise the frame keeps its scale and no CRS, so lengths still work
 * and every WGS 84 conversion answers null (`mapGeo.epsgOf`).
 */
export async function documentPaperFrame(db: Db, hash: string, correctionDeg: number): Promise<mapGeo.PaperFrame | null> {
  const stored = await documentFrame(db, hash);
  if (!stored) return null;
  const { unitsPerMm, mapScale, georeferencing } = stored.frame;
  const fallback = georeferencing.crs === null ? await sourceFrameFallback(db, stored.sourceHash) : null;
  return { ...(fallback ?? { unitsPerMm, mapScale, georeferencing }), correctionDeg };
}

/**
 * The `map_files` quick-access columns of a stored document under
 * `correctionDeg` (docs/map-storage.md §6.4) — the pin's function, with
 * the source fallback for an unresolved CRS so a rotation change on such
 * a map writes what its upload wrote. Scale only when nothing projects;
 * null when the document is missing.
 */
export async function documentMapFileColumns(db: Db, hash: string, correctionDeg: number): Promise<mapGeo.MapFileMetadata | null> {
  const stored = await documentFrame(db, hash);
  if (!stored) return null;
  const tilt = (await documentNorth(db, hash))?.meridian?.medianTiltDeg ?? null;
  const direct = mapFileMetadataFor(stored.frame, tilt, correctionDeg);
  if (direct) return direct;
  const fallback = stored.frame.georeferencing.crs === null ? await sourceFrameFallback(db, stored.sourceHash) : null;
  const inferred = fallback ? mapFileMetadataFor({ ...stored.frame, georeferencing: fallback.georeferencing }, tilt, correctionDeg) : null;
  return inferred ?? { scale: stored.frame.mapScale, bounds: null, northOffset: null, calibration: null };
}

/** For tests: drop every cached frame, report and document. */
export function clearEventDocumentCaches(): void {
  frames.clear();
  norths.clear();
  decoded.clear();
  sourceFrames.clear();
}
