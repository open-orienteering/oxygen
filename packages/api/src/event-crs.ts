/**
 * Cached access to the event map's OCAD CRS.
 *
 * Several code paths need the coordinate reference system of the uploaded
 * OCAD map (converting control map-mm positions to WGS84, computing course
 * lengths from the map scale). Parsing the whole OCD blob just to read the
 * CRS is expensive — a big club map is tens of MB — so this module caches
 * the parsed CRS per event, keyed by the map file's `uploadedAt` stamp
 * (which `uploadMap` and `importCourses` both bump on any change).
 */

import {
  withGrivationCorrection,
  type OcadCrs,
} from "./map-projection.js";

/** The subset of the Prisma client this helper needs (works inside $transaction too). */
interface MapFileReader {
  mapFile: {
    findFirst(args: {
      where: { eventId: bigint };
      orderBy: { uploadedAt: "desc" };
      select: Record<string, boolean>;
    }): Promise<{
      uploadedAt?: Date;
      fileData?: Uint8Array;
      rotationCorrection?: number;
    } | null>;
  };
}

const cache = new Map<
  string,
  { uploadedAtMs: number; rotationCorrection: number; crs: OcadCrs | null }
>();

/**
 * Return the CRS of the event's latest uploaded map, or null when there is
 * no map or its grid is unparseable. Results are cached until a newer map
 * file (by `uploadedAt`) appears.
 */
export async function loadEventCrs(
  db: MapFileReader,
  eventId: bigint,
): Promise<OcadCrs | null> {
  const key = eventId.toString();
  const meta = await db.mapFile.findFirst({
    where: { eventId },
    orderBy: { uploadedAt: "desc" },
    select: { uploadedAt: true, rotationCorrection: true },
  });
  if (!meta?.uploadedAt) {
    cache.delete(key);
    return null;
  }
  const uploadedAtMs = meta.uploadedAt.getTime();
  const rotationCorrection = meta.rotationCorrection ?? 0;
  const cached = cache.get(key);
  if (
    cached &&
    cached.uploadedAtMs === uploadedAtMs &&
    cached.rotationCorrection === rotationCorrection
  ) {
    return cached.crs;
  }

  let crs: OcadCrs | null = null;
  try {
    const row = await db.mapFile.findFirst({
      where: { eventId },
      orderBy: { uploadedAt: "desc" },
      select: { fileData: true },
    });
    if (row?.fileData) {
      const ocadMod = await import("ocad2geojson");
      const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
        buf: Buffer,
        opts?: Record<string, unknown>,
      ) => Promise<{ getCrs(): OcadCrs }>;
      const ocadFile = await readOcad(Buffer.from(row.fileData), {
        quietWarnings: true,
      });
      crs = withGrivationCorrection(
        ocadFile.getCrs(),
        rotationCorrection,
      );
    }
  } catch (err) {
    console.warn("[event-crs] OCAD CRS load failed:", err);
    crs = null;
  }
  cache.set(key, { uploadedAtMs, rotationCorrection, crs });
  return crs;
}
