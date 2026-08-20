/**
 * Cached access to the base map's terrain objects, slimmed for spatial
 * search.
 *
 * The description autodetect needs to ask "what map features are within a
 * few millimetres of this point?". The tile pipeline
 * (`map-tiles.ts`) throws the parsed `OcadFile` away after rasterising, so
 * this module keeps its own cache — the same shape as `event-crs.ts`:
 * per event, invalidated when a newer `map_files.uploaded_at` shows up.
 *
 * Only objects whose symbol has an entry in `ISOM_DESCRIPTION_MAP` are
 * kept, which drops contours, course overprint and text objects — the
 * bulk of a club map — so the retained set stays small.
 *
 * Coordinates are OCAD's native 1/100 mm paper units (`TdPoly` already
 * applies the `>> 8` shift). Bezier control points are treated as
 * ordinary polyline vertices: for a distance-to-feature estimate at
 * millimetre scale the difference is irrelevant.
 */

import { isomDescriptionFor } from "@oxygen/shared";

/** Point (1), line (2) or area (3) object. Text/rect types are dropped. */
export type SlimObjectType = 1 | 2 | 3;

export interface SlimMapObject {
  /** Full OCAD symbol number, e.g. 204000 for ISOM 204 (boulder). */
  sym: number;
  objType: SlimObjectType;
  /** 1/100 mm paper coordinates. Areas keep their outer ring only. */
  coordinates: Array<[number, number]>;
  /** [minX, minY, maxX, maxY] in the same units. */
  bbox: [number, number, number, number];
}

/** The subset of the Prisma client this helper needs. */
interface MapFileReader {
  mapFile: {
    findFirst(args: {
      where: { eventId: bigint };
      orderBy: { uploadedAt: "desc" };
      select: Record<string, boolean>;
    }): Promise<{ uploadedAt?: Date; fileData?: Uint8Array } | null>;
  };
}

const cache = new Map<
  string,
  { uploadedAtMs: number; objects: SlimMapObject[] | null }
>();

/**
 * How many events to keep parsed at once. Unlike the CRS cache, an entry
 * here is a few MB for a real club map, and a server can host hundreds
 * of events — editing happens in one at a time, so a tiny bound is
 * plenty.
 */
const MAX_CACHED_EVENTS = 3;

interface RawOcadObject {
  sym: number;
  objType: number;
  coordinates: Array<
    ArrayLike<number> & { isFirstHolePoint?: () => boolean }
  >;
}

/** Slim one OCAD object down, or null when it isn't searchable. */
export function slimObject(obj: RawOcadObject): SlimMapObject | null {
  if (obj.objType !== 1 && obj.objType !== 2 && obj.objType !== 3) return null;
  if (!isomDescriptionFor(obj.sym)) return null;

  const coords: Array<[number, number]> = [];
  for (const c of obj.coordinates ?? []) {
    // Areas may carry holes after the outer ring; the search only needs
    // the outline, and ignoring holes at most makes a control inside a
    // hole look "on" the feature — acceptable for a suggestion.
    if (coords.length > 0 && obj.objType === 3 && c.isFirstHolePoint?.()) break;
    const x = c[0];
    const y = c[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    coords.push([x, y]);
  }
  if (coords.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return {
    sym: obj.sym,
    objType: obj.objType as SlimObjectType,
    coordinates: coords,
    bbox: [minX, minY, maxX, maxY],
  };
}

/**
 * Searchable terrain objects of the event's latest uploaded map, or null
 * when there is no map (or it failed to parse). Cached until a newer map
 * file appears.
 */
export async function loadEventMapObjects(
  db: MapFileReader,
  eventId: bigint,
): Promise<SlimMapObject[] | null> {
  const key = eventId.toString();
  const meta = await db.mapFile.findFirst({
    where: { eventId },
    orderBy: { uploadedAt: "desc" },
    select: { uploadedAt: true },
  });
  if (!meta?.uploadedAt) {
    cache.delete(key);
    return null;
  }
  const uploadedAtMs = meta.uploadedAt.getTime();
  const cached = cache.get(key);
  if (cached && cached.uploadedAtMs === uploadedAtMs) return cached.objects;

  let objects: SlimMapObject[] | null = null;
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
      ) => Promise<{ objects: RawOcadObject[] }>;
      const ocadFile = await readOcad(Buffer.from(row.fileData), {
        quietWarnings: true,
      });
      objects = [];
      for (const obj of ocadFile.objects ?? []) {
        const slim = slimObject(obj);
        if (slim) objects.push(slim);
      }
    }
  } catch (err) {
    console.warn("[event-map-objects] OCAD parse failed:", err);
    objects = null;
  }
  cache.set(key, { uploadedAtMs, objects });
  // Map iterates in insertion order, so the first key is the oldest.
  while (cache.size > MAX_CACHED_EVENTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    cache.delete(oldest);
  }
  return objects;
}
