/**
 * Apply an OCAD blob as the event's current map and parse library metadata.
 *
 * Event maps stay per-event copies (`map_files`). Club library rows live in
 * `club_map_files` and are copied in via `course.useClubMap`.
 */

import type { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { fireMapUpload } from "./db.js";
import { rebuildCourseGeometry } from "./course-geometry.js";
import { emitCourseUpserted } from "./referenceJournal.js";
import {
  ocadBoundsToWgs84,
  ocadToWgs84,
  computeMapNorthOffset,
  withGrivationCorrection,
  type OcadCrs,
  type WGS84Bounds,
} from "./map-projection.js";
import {
  detectNorthCorrection,
  displayNorthOffsetDeg,
  probeMeridianLines,
  type NorthDetection,
  type OcadNorthSource,
} from "./map-north.js";

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

export type ClubMapMetadata = {
  scale: number | null;
  bounds: WGS84Bounds | null;
  northOffset: number | null;
  calibration: MapCalibrationPoint[] | null;
};

export type ResolvedMapNorth = {
  metadata: ClubMapMetadata;
  rotationCorrection: number;
  northDetection: NorthDetection | null;
};

type OcadParsed = OcadNorthSource & {
  getBounds(): number[];
};

async function readOcadQuiet(buffer: Buffer): Promise<OcadParsed | null> {
  try {
    const ocadMod = await import("ocad2geojson");
    const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
      buf: Buffer,
      opts?: Record<string, unknown>,
    ) => Promise<OcadParsed>;
    return await readOcad(buffer, { quietWarnings: true });
  } catch (err) {
    console.warn("[readOcadQuiet] OCAD parse failed:", err);
    return null;
  }
}

function metadataFromOcad(
  ocad: OcadParsed,
  rotationCorrectionDeg: number,
): ClubMapMetadata {
  const crs = withGrivationCorrection(ocad.getCrs(), rotationCorrectionDeg);
  const ocadBounds = ocad.getBounds();

  // `northOffset` is the bearing from true north to the direction the
  // viewer puts at the top of the screen (MapViewer rotates by
  // -northOffset). Base value: paper +Y. When the file contains a
  // meridian-line cluster (ISOM 601.x, often tilted inside the drawing —
  // Nackareservatet: 3.3°), fold that tilt in so screen-up follows the
  // meridians and they render vertical. Without the fold the viewer shows
  // paper-up and the meridians lean by their in-paper tilt no matter what
  // rotationCorrection is set to — correction rotates the georeference
  // and northOffset by the same amount, which cancels on screen.
  const northOffset = displayNorthOffsetDeg(
    computeMapNorthOffset(ocadBounds, crs),
    probeMeridianLines(ocad.objects ?? []),
  );

  return {
    scale: crs.scale ?? null,
    bounds: ocadBoundsToWgs84(ocadBounds, crs),
    northOffset,
    calibration: computeCalibration(ocadBounds, crs),
  };
}

/**
 * Best-effort OCAD parse. Corrupt / non-OCAD buffers return nulls and
 * never throw — same contract as `course.mapMetadata`.
 *
 * `rotationCorrectionDeg` (clockwise positive) is added to the file's
 * own grivation before deriving bounds / north offset / calibration —
 * for club maps whose drawing is magnetic-north-up but ScalePar a=0.
 */
export async function parseOcadMapMetadata(
  buffer: Buffer,
  rotationCorrectionDeg = 0,
): Promise<ClubMapMetadata> {
  const ocad = await readOcadQuiet(buffer);
  if (!ocad) {
    return { scale: null, bounds: null, northOffset: null, calibration: null };
  }
  try {
    return metadataFromOcad(ocad, rotationCorrectionDeg);
  } catch (err) {
    console.warn("[parseOcadMapMetadata] OCAD parse failed:", err);
    return { scale: null, bounds: null, northOffset: null, calibration: null };
  }
}

/**
 * Parse OCAD, run north detection, and resolve the rotation correction
 * to apply. When `forcedCorrection` is set (e.g. copying from the club
 * library) it wins; otherwise auto-apply the physics suggestion when
 * the meridian gate passes.
 */
export async function resolveMapNorth(
  buffer: Buffer,
  opts: { forcedCorrection?: number } = {},
): Promise<ResolvedMapNorth> {
  const empty: ResolvedMapNorth = {
    metadata: {
      scale: null,
      bounds: null,
      northOffset: null,
      calibration: null,
    },
    rotationCorrection: opts.forcedCorrection ?? 0,
    northDetection: null,
  };
  const ocad = await readOcadQuiet(buffer);
  if (!ocad) return empty;

  let northDetection: NorthDetection | null = null;
  try {
    northDetection = detectNorthCorrection(ocad);
  } catch (err) {
    console.warn("[resolveMapNorth] north detection failed:", err);
  }

  let rotationCorrection = opts.forcedCorrection ?? 0;
  if (opts.forcedCorrection === undefined) {
    if (
      northDetection?.shouldAutoApply &&
      northDetection.suggestedCorrectionDeg != null
    ) {
      rotationCorrection = northDetection.suggestedCorrectionDeg;
    }
  }

  try {
    return {
      metadata: metadataFromOcad(ocad, rotationCorrection),
      rotationCorrection,
      northDetection,
    };
  } catch (err) {
    console.warn("[resolveMapNorth] metadata derive failed:", err);
    return { ...empty, rotationCorrection, northDetection };
  }
}

/**
 * Map-mm ↔ WGS84 anchors at the four corners of the map extent.
 * `ocadBounds` is in OCAD internal units (hundredths of mm); the client
 * coordinate space is paper mm, hence the /100.
 */
function computeCalibration(
  ocadBounds: number[],
  crs: OcadCrs,
): MapCalibrationPoint[] | null {
  const [minX, minY, maxX, maxY] = ocadBounds;
  const corners: [number, number][] = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ];
  const points: MapCalibrationPoint[] = [];
  for (const [x, y] of corners) {
    const wgs = ocadToWgs84(x, y, crs);
    if (!wgs) return null;
    points.push({ mapX: x / 100, mapY: y / 100, lat: wgs.lat, lng: wgs.lng });
  }
  return points;
}

function detectionJson(
  detection: NorthDetection | null,
): Prisma.InputJsonValue | undefined {
  if (!detection) return undefined;
  return detection as unknown as Prisma.InputJsonValue;
}

/** Replace the event map, drop tile caches, rebuild editor course geometry. */
export async function applyEventMap(
  db: Db,
  eventId: bigint,
  fileName: string,
  buffer: Buffer,
  opts: {
    fromClubLibrary?: boolean;
    /** When set (club-library copy), skip auto-detect apply and use this. */
    rotationCorrection?: number;
  } = {},
): Promise<{ fileName: string; size: number; rotationCorrection: number }> {
  const resolved = await resolveMapNorth(buffer, {
    forcedCorrection: opts.rotationCorrection,
  });
  await db.mapFile.deleteMany({ where: { eventId } });
  await db.mapFile.create({
    data: {
      eventId,
      fileName,
      fileData: Uint8Array.from(buffer),
      scale: resolved.metadata.scale,
      bounds: resolved.metadata.bounds
        ? (resolved.metadata.bounds as unknown as Prisma.InputJsonValue)
        : undefined,
      northOffset: resolved.metadata.northOffset,
      calibration: resolved.metadata.calibration
        ? (resolved.metadata.calibration as unknown as Prisma.InputJsonValue)
        : undefined,
      rotationCorrection: resolved.rotationCorrection,
      northDetection: detectionJson(resolved.northDetection),
      fromClubLibrary: opts.fromClubLibrary === true,
    },
  });
  await db.mapTile.deleteMany({ where: { eventId } });
  await db.renderedMap.deleteMany({ where: { eventId } });
  fireMapUpload(eventId);

  const editorCourses = await db.course.findMany({
    where: { eventId, removed: false, geometrySource: "editor" },
    select: { id: true },
  });
  if (editorCourses.length > 0) {
    const ids = editorCourses.map((c) => c.id);
    await rebuildCourseGeometry(db, eventId, ids, { updateLength: false });
    for (const id of ids) {
      await emitCourseUpserted(db, eventId, id);
    }
  }

  return {
    fileName,
    size: buffer.length,
    rotationCorrection: resolved.rotationCorrection,
  };
}

/**
 * Persist a north/grivation correction for the event's current map,
 * re-derive metadata from the stored blob, and drop tile caches so the
 * next render warps with the corrected CRS.
 */
export async function applyMapRotationCorrection(
  db: Db,
  eventId: bigint,
  rotationCorrectionDeg: number,
): Promise<ClubMapMetadata & { rotationCorrection: number }> {
  const row = await db.mapFile.findFirst({
    where: { eventId },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, fileData: true, northDetection: true },
  });
  if (!row) {
    throw new Error("No map file uploaded");
  }
  const metadata = await parseOcadMapMetadata(
    Buffer.from(row.fileData),
    rotationCorrectionDeg,
  );
  await db.mapFile.update({
    where: { id: row.id },
    data: {
      rotationCorrection: rotationCorrectionDeg,
      scale: metadata.scale,
      bounds: metadata.bounds
        ? (metadata.bounds as unknown as Prisma.InputJsonValue)
        : undefined,
      northOffset: metadata.northOffset,
      calibration: metadata.calibration
        ? (metadata.calibration as unknown as Prisma.InputJsonValue)
        : undefined,
      // Bump stamp so clients and the tile SVG cache invalidate.
      uploadedAt: new Date(),
    },
  });
  await db.mapTile.deleteMany({ where: { eventId } });
  await db.renderedMap.deleteMany({ where: { eventId } });
  fireMapUpload(eventId);

  const editorCourses = await db.course.findMany({
    where: { eventId, removed: false, geometrySource: "editor" },
    select: { id: true },
  });
  if (editorCourses.length > 0) {
    const ids = editorCourses.map((c) => c.id);
    await rebuildCourseGeometry(db, eventId, ids, { updateLength: false });
    for (const id of ids) {
      await emitCourseUpserted(db, eventId, id);
    }
  }

  return { ...metadata, rotationCorrection: rotationCorrectionDeg };
}

/**
 * Persist a north/grivation correction on a club-library map and
 * re-derive scale / bounds / northOffset / preview metadata.
 */
export async function applyClubMapRotationCorrection(
  db: Db,
  clubMapId: bigint,
  rotationCorrectionDeg: number,
): Promise<ClubMapMetadata & { rotationCorrection: number }> {
  const row = await db.clubMapFile.findUnique({
    where: { id: clubMapId },
    select: { id: true, fileData: true },
  });
  if (!row) {
    throw new Error(`Club map ${clubMapId} not found`);
  }
  const metadata = await parseOcadMapMetadata(
    Buffer.from(row.fileData),
    rotationCorrectionDeg,
  );
  await db.clubMapFile.update({
    where: { id: row.id },
    data: {
      rotationCorrection: rotationCorrectionDeg,
      scale: metadata.scale,
      bounds: metadata.bounds
        ? (metadata.bounds as unknown as Prisma.InputJsonValue)
        : undefined,
      northOffset: metadata.northOffset,
    },
  });
  return { ...metadata, rotationCorrection: rotationCorrectionDeg };
}
