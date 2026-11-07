/**
 * Make a map file the event's current map (docs/map-storage.md §3, §6).
 *
 * The bytes are a content-addressed `map_sources` row; the event's
 * `map_files` row pins it (`source_hash`) and, once the import job
 * finishes, its document (`document_hash`, with the quick-access columns
 * the pin writes, §6.4). Nothing here parses the file: since E5 the
 * upload stores and pins only, and every reader reads the document.
 * Club-library maps are copied in via `course.useClubMap`.
 */

import { createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { prisma } from "./db.js";
import { rebuildCourseLengths } from "./course-geometry.js";
import { emitCourseUpserted } from "./referenceJournal.js";
import type { WGS84Bounds } from "./map-projection.js";
import { meridianStalenessFromDetection } from "./map-north.js";
import { synchronizePositionedControlCoordinates } from "./event-crs.js";
import { documentMapFileColumns, documentNorth, eventPin } from "./map-store/event-document.js";
import { sniffMapKind } from "./map-store/uploads.js";
import { startImportJob, type ImportJobRow } from "./map-store/jobs.js";

export { synchronizePositionedControlCoordinates };

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A map-mm ↔ WGS84 anchor point. Three or more of these let the web
 * viewer build its affine transform even when the event has no placed
 * controls yet (a fresh event's course editor was dead without them).
 */
export type MapCalibrationPoint = {
  /** Paper millimetres — the `controls.xpos`/`ypos` coordinate space. */
  mapX: number;
  mapY: number;
  lat: number;
  lng: number;
};

/** The quick-access georeference columns of a `map_files` row. */
export type MapFileMetadata = {
  scale: number | null;
  bounds: WGS84Bounds | null;
  northOffset: number | null;
  calibration: MapCalibrationPoint[] | null;
};

/**
 * Today's drawn-meridian staleness of a pinned document (its import
 * report's `north`, the value `course.mapMetadata` answers); null without
 * a document or without north lines.
 */
async function documentStaleness(db: Db, documentHash: string | null): Promise<number | null> {
  if (!documentHash) return null;
  return meridianStalenessFromDetection(await documentNorth(db, documentHash));
}

/**
 * Re-derive the lengths of every course whose length is derived from its
 * controls (`length_source = 'derived'`) after the map's scale or
 * georeference changed, and re-emit them. Lengths stay as stored; the
 * legs string follows the new scale.
 */
async function refreshDerivedCourses(db: Db, eventId: bigint): Promise<void> {
  const derived = await db.course.findMany({
    where: { eventId, removed: false, lengthSource: "derived" },
    select: { id: true },
  });
  if (derived.length === 0) return;
  const ids = derived.map((c) => c.id);
  await rebuildCourseLengths(db, eventId, ids, { updateLength: false });
  for (const id of ids) {
    // Derived fields only: the structure and its token are unchanged.
    await emitCourseUpserted(db, eventId, id, { advanceVersion: false });
  }
}

/**
 * Make `fileName` the event's map: store the bytes as a source (unless
 * `opts.fileHash` names one already stored — the chunked upload and the
 * club library), replace the event's `map_files` row with one pinning it,
 * and run the import job (awaited up to the hold).
 *
 * `buffer` may be null when `opts.fileHash` names an existing source.
 */
export async function applyEventMap(
  db: Db,
  eventId: bigint,
  fileName: string,
  buffer: Buffer | null,
  opts: {
    fromClubLibrary?: boolean;
    /** Club-library copy: carry the series' manual correction along. */
    rotationCorrection?: number;
    /** The source's content hash, when it is already in `map_sources`. */
    fileHash?: string;
    /** Recorded on the content-addressed source row (docs/map-storage.md). */
    uploadedBy?: string | null;
    /** The signed-in user making the request; recorded on the import job (docs/map-storage.md §4.2, §6.1). */
    startedBy?: string | null;
    /** How long to wait for the import job before returning (default 30 s; 0 = don't wait). */
    importHoldMs?: number;
  } = {},
): Promise<{
  fileName: string;
  size: number;
  rotationCorrection: number;
  /** Drawn-meridian staleness from the pinned document's report; null until the pin or without north lines. */
  meridianStalenessDeg: number | null;
  /** Pinned map document; null while the import job is still running or if it failed. */
  documentHash: string | null;
  /** The import job recording this upload (docs/map-storage.md §6); null only if it could not be created. */
  importJob: { id: string; state: ImportJobRow["state"]; error: string | null } | null;
}> {
  const rotationCorrection = opts.rotationCorrection ?? 0;
  let fileHash: string;
  let size: number;
  if (buffer) {
    fileHash = opts.fileHash ?? createHash("sha256").update(buffer).digest("hex");
    size = buffer.byteLength;
    // Stage 9 of the document pipeline (docs/map-storage.md §3): the upload
    // is a content-addressed source row the event pins.
    await db.mapSource.createMany({
      data: [{ fileHash, kind: sniffMapKind(buffer) ?? "ocad", bytes: Uint8Array.from(buffer), sizeBytes: buffer.byteLength, fileName, uploadedBy: opts.uploadedBy ?? null }],
      skipDuplicates: true,
    });
  } else {
    if (!opts.fileHash) throw new Error("applyEventMap: neither bytes nor a source hash");
    fileHash = opts.fileHash;
    const source = await db.mapSource.findUnique({ where: { fileHash }, select: { sizeBytes: true } });
    if (!source) throw new Error(`applyEventMap: source ${fileHash} not found`);
    size = source.sizeBytes;
  }

  await db.mapFile.deleteMany({ where: { eventId } });
  await db.mapFile.create({
    data: {
      eventId,
      fileName,
      sourceHash: fileHash,
      rotationCorrection,
      fromClubLibrary: opts.fromClubLibrary === true,
    },
  });
  // The import job produces the document and pins it on this row with
  // the quick-access columns (§6.4); control lat/lng follow the pin
  // (`applyJobResult`). Until then the event has no frame.
  const job = await startImportJob(prisma(), { sourceHash: fileHash, eventId, startedBy: opts.startedBy ?? null, holdMs: opts.importHoldMs })
    .catch((err: unknown) => {
      console.error(`[map-import] event ${eventId}: could not start the import of ${fileName}:`, err);
      return null;
    });

  // Derived lengths follow the new map's scale once it is pinned; an
  // import that outlives the hold leaves no scale, and the lengths follow
  // with the next write after the pin.
  await refreshDerivedCourses(db, eventId);

  const documentHash = job?.state === "done" ? job.documentHash : null;
  return {
    fileName,
    size,
    rotationCorrection,
    meridianStalenessDeg: await documentStaleness(db, documentHash),
    documentHash,
    importJob: job ? { id: job.id, state: job.state, error: job.error } : null,
  };
}

/**
 * Persist a north/grivation correction for the event's current map and
 * re-derive the quick-access columns from the pinned document (the pin's
 * function, docs/map-storage.md §6.4). Without a pin only the correction
 * is stored; the pin recomputes the columns with it.
 */
export async function applyMapRotationCorrection(
  db: Db,
  eventId: bigint,
  rotationCorrectionDeg: number,
): Promise<MapFileMetadata & { rotationCorrection: number }> {
  const row = await eventPin(db, eventId);
  if (!row) {
    throw new Error("No map file uploaded");
  }
  const columns = row.documentHash
    ? await documentMapFileColumns(db, row.documentHash, rotationCorrectionDeg)
    : null;
  const metadata: MapFileMetadata = columns
    ? { ...columns, calibration: columns.calibration as MapCalibrationPoint[] | null }
    : { scale: row.scale, bounds: null, northOffset: null, calibration: null };
  await db.mapFile.update({
    where: { id: row.id },
    data: {
      rotationCorrection: rotationCorrectionDeg,
      ...(columns
        ? {
            scale: metadata.scale,
            bounds: metadata.bounds
              ? (metadata.bounds as unknown as Prisma.InputJsonValue)
              : undefined,
            northOffset: metadata.northOffset,
            calibration: metadata.calibration
              ? (metadata.calibration as unknown as Prisma.InputJsonValue)
              : undefined,
          }
        : {}),
      // Bump stamp so clients holding the map's metadata refetch it.
      uploadedAt: new Date(),
    },
  });
  await synchronizePositionedControlCoordinates(db, eventId);
  await refreshDerivedCourses(db, eventId);

  return { ...metadata, rotationCorrection: rotationCorrectionDeg };
}
