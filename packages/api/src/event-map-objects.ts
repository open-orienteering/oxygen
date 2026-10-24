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
 * applies the `>> 8` shift). Bezier segments are flattened into short
 * polyline runs: junction / crossing / corner detection compares
 * geometry at a few tenths of a millimetre, and a curved path whose
 * control handles sit a millimetre off the drawn line would otherwise
 * never register as meeting the path it ends on.
 */

import { course, isomDescriptionFor, mapDocument, mapImport } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { LruCache } from "./course-maps/lru-cache.js";
import { pinnedDocumentHash } from "./course-maps/map-source.js";
import { getBlob } from "./map-store/blob-store.js";
import { cutFeaturesOfSlimObjects } from "./overprint-cuts.js";

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

interface ParsedMap {
  objects: SlimMapObject[];
  /** Radii of the file's cut symbols as it draws them, mm by `sym` (`course.ocadCutSymbolRadiiMm`). */
  cutRadii: Map<number, number>;
}

const cache = new Map<
  string,
  { uploadedAtMs: number; parsed: ParsedMap | null }
>();

/**
 * How many events to keep parsed at once. Unlike the CRS cache, an entry
 * here is a few MB for a real club map, and a server can host hundreds
 * of events — editing happens in one at a time, so a tiny bound is
 * plenty.
 */
const MAX_CACHED_EVENTS = 3;

/** One `TdPoly` coordinate as ocad2geojson exposes it. */
export type RawOcadCoordinate = ArrayLike<number> & {
  isFirstHolePoint?: () => boolean;
  isFirstBezier?: () => boolean;
  isSecondBezier?: () => boolean;
};

interface RawOcadObject {
  sym: number;
  objType: number;
  coordinates: RawOcadCoordinate[];
}

interface RawOcadFile {
  objects: RawOcadObject[];
  symbols?: ArrayLike<mapImport.OcadSymbolDefLike>;
  header?: { version?: number };
}

/** Straight segments per cubic Bezier when flattening. */
const BEZIER_STEPS = 8;

function finitePoint(c: RawOcadCoordinate): [number, number] | null {
  const x = c[0];
  const y = c[1];
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/**
 * Flatten an OCAD coordinate list. A cubic segment is stored as
 * `P0, C1 (first-bezier flag), C2 (second-bezier flag), P3`; everything
 * else is a plain vertex. Stops at the first hole point of an area.
 */
export function flattenOcadCoordinates(
  raw: RawOcadCoordinate[],
  objType: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    // Areas may carry holes after the outer ring; the search only needs
    // the outline, and ignoring holes at most makes a control inside a
    // hole look "on" the feature — acceptable for a suggestion.
    if (out.length > 0 && objType === 3 && c.isFirstHolePoint?.()) break;

    if (
      out.length > 0 &&
      c.isFirstBezier?.() &&
      i + 2 < raw.length &&
      raw[i + 1].isSecondBezier?.()
    ) {
      const p0 = out[out.length - 1];
      const c1 = finitePoint(c);
      const c2 = finitePoint(raw[i + 1]);
      const p3 = finitePoint(raw[i + 2]);
      if (c1 && c2 && p3) {
        for (let s = 1; s <= BEZIER_STEPS; s++) {
          const t = s / BEZIER_STEPS;
          const mt = 1 - t;
          const a = mt * mt * mt;
          const b = 3 * mt * mt * t;
          const cc = 3 * mt * t * t;
          const d = t * t * t;
          out.push([
            a * p0[0] + b * c1[0] + cc * c2[0] + d * p3[0],
            a * p0[1] + b * c1[1] + cc * c2[1] + d * p3[1],
          ]);
        }
        i += 3;
        continue;
      }
    }

    const p = finitePoint(c);
    if (p) out.push(p);
    i++;
  }
  return out;
}

/** Slim one OCAD object down, or null when it isn't searchable. */
export function slimObject(obj: RawOcadObject): SlimMapObject | null {
  if (obj.objType !== 1 && obj.objType !== 2 && obj.objType !== 3) return null;
  if (!isomDescriptionFor(obj.sym)) return null;

  const coords = flattenOcadCoordinates(obj.coordinates ?? [], obj.objType);
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
  return (await loadParsedMap(db, eventId))?.objects ?? null;
}

async function loadParsedMap(
  db: MapFileReader,
  eventId: bigint,
): Promise<ParsedMap | null> {
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
  if (cached && cached.uploadedAtMs === uploadedAtMs) return cached.parsed;

  let parsed: ParsedMap | null = null;
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
      ) => Promise<RawOcadFile>;
      const ocadFile = await readOcad(Buffer.from(row.fileData), {
        quietWarnings: true,
      });
      const objects: SlimMapObject[] = [];
      for (const obj of ocadFile.objects ?? []) {
        const slim = slimObject(obj);
        if (slim) objects.push(slim);
      }
      const cutRadii = ocadFile.symbols
        ? course.ocadCutSymbolRadiiMm(ocadFile.symbols, ocadFile.header?.version)
        : new Map<number, number>();
      parsed = { objects, cutRadii };
    }
  } catch (err) {
    console.warn("[event-map-objects] OCAD parse failed:", err);
    parsed = null;
  }
  cache.set(key, { uploadedAtMs, parsed });
  // Map iterates in insertion order, so the first key is the oldest.
  while (cache.size > MAX_CACHED_EVENTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    cache.delete(oldest);
  }
  return parsed;
}

// ─── Automatic-cut features ──────────────────────────────────

/** Cut features of a decoded document, memoised per hash (content-addressed, so never stale). */
const documentFeatures = new LruCache<course.CutFeature[]>(MAX_CACHED_EVENTS);

export interface EventCutFeatures {
  features: course.CutFeature[];
  /** `document`: the pinned map document (`vector` events); `ocad`: the legacy parse of the uploaded file. */
  source: "document" | "ocad";
}

/**
 * The features the course overprint is cut around (docs/course-layer.md
 * §3.4, §4): from the pinned document when the event reads documents
 * (`vector` + a pin — the reads-only gate of docs/map-pipeline-switch.md
 * §3), else from the OCAD parse with radii by `mapScale`. Null when the
 * event has no usable map.
 */
export async function loadEventCutFeatures(
  db: PrismaClient | Prisma.TransactionClient,
  eventId: bigint,
  mapScale: number | null,
): Promise<EventCutFeatures | null> {
  const hash = await pinnedDocumentHash(db, eventId);
  const fromDocument = hash ? await loadDocumentCutFeatures(db, hash) : null;
  if (fromDocument) return { features: fromDocument, source: "document" };
  const fromOcad = await loadOcadCutFeatures(db, eventId, mapScale);
  return fromOcad ? { features: fromOcad, source: "ocad" } : null;
}

/** Cut features of a stored map document; null when it is missing or unreadable. */
export async function loadDocumentCutFeatures(
  db: PrismaClient | Prisma.TransactionClient,
  hash: string,
): Promise<course.CutFeature[] | null> {
  const cached = documentFeatures.get(hash);
  if (cached) return cached;
  const bytes = await getBlob(db, "map_documents", hash);
  if (!bytes) return null;
  try {
    const features = course.cutFeaturesOfDocument(mapDocument.decodeMapDocument(bytes));
    documentFeatures.set(hash, features);
    return features;
  } catch (err) {
    console.warn(`[event-map-objects] document ${hash} unreadable, using the OCAD parse:`, err);
    return null;
  }
}

/** Cut features of the event's latest uploaded OCAD file; null without a parseable map. */
export async function loadOcadCutFeatures(
  db: MapFileReader,
  eventId: bigint,
  mapScale: number | null,
): Promise<course.CutFeature[] | null> {
  const parsed = await loadParsedMap(db, eventId);
  return parsed ? cutFeaturesOfSlimObjects(parsed.objects, parsed.cutRadii, mapScale) : null;
}
