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
  type OcadCrs,
  type WGS84Bounds,
} from "./map-projection.js";

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

/**
 * Best-effort OCAD parse. Corrupt / non-OCAD buffers return nulls and
 * never throw — same contract as `course.mapMetadata`.
 */
export async function parseOcadMapMetadata(
  buffer: Buffer,
): Promise<ClubMapMetadata> {
  try {
    const ocadMod = await import("ocad2geojson");
    const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
      buf: Buffer,
      opts?: Record<string, unknown>,
    ) => Promise<{ getCrs(): OcadCrs; getBounds(): number[] }>;
    const ocadFile = await readOcad(buffer, { quietWarnings: true });
    const crs = ocadFile.getCrs();
    const ocadBounds = ocadFile.getBounds();
    return {
      scale: crs.scale ?? null,
      bounds: ocadBoundsToWgs84(ocadBounds, crs),
      northOffset: computeMapNorthOffset(ocadBounds, crs),
      calibration: computeCalibration(ocadBounds, crs),
    };
  } catch (err) {
    console.warn("[parseOcadMapMetadata] OCAD parse failed:", err);
    return { scale: null, bounds: null, northOffset: null, calibration: null };
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

/** Replace the event map, drop tile caches, rebuild editor course geometry. */
export async function applyEventMap(
  db: Db,
  eventId: bigint,
  fileName: string,
  buffer: Buffer,
  opts: { fromClubLibrary?: boolean } = {},
): Promise<{ fileName: string; size: number }> {
  const metadata = await parseOcadMapMetadata(buffer);
  await db.mapFile.deleteMany({ where: { eventId } });
  await db.mapFile.create({
    data: {
      eventId,
      fileName,
      fileData: Uint8Array.from(buffer),
      scale: metadata.scale,
      bounds: metadata.bounds
        ? (metadata.bounds as unknown as Prisma.InputJsonValue)
        : undefined,
      northOffset: metadata.northOffset,
      calibration: metadata.calibration
        ? (metadata.calibration as unknown as Prisma.InputJsonValue)
        : undefined,
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

  return { fileName, size: buffer.length };
}
