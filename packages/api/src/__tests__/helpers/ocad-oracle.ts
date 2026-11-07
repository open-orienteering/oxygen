/**
 * The legacy OCAD readers, kept as the parity oracle for the document
 * readers (docs/map-storage.md §4.6): the description autodetect's object
 * slimming and the automatic-cut feature source as they ran over
 * `map_files.file_data` before slice E1, and the upload's metadata parse
 * (`parseOcadMapMetadata`) the pin's quick-access columns must equal, which
 * production ran at upload until E5. Test-only — production reads the
 * pinned document (`event-map-objects.ts`, `map-file-metadata.ts`).
 */

import { course, isomDescriptionFor, mapImport } from "@oxygen/shared";
import type { SlimMapObject, SlimObjectType } from "../../event-map-objects.js";
import type { MapFileMetadata } from "../../event-map.js";
import { frameFromOcadCrs, type OcadCrs } from "../../map-projection.js";
import { mapFileMetadataFor } from "../../map-store/map-file-metadata.js";

/** One `TdPoly` coordinate as ocad2geojson exposes it. */
export type RawOcadCoordinate = ArrayLike<number> & {
  isFirstHolePoint?: () => boolean;
  isFirstBezier?: () => boolean;
  isSecondBezier?: () => boolean;
};

export interface RawOcadObject {
  sym: number;
  objType: number;
  coordinates: RawOcadCoordinate[];
}

export interface RawOcadFile {
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


/** The legacy autodetect objects of a parsed OCAD file. */
export function slimObjectsOfOcad(file: RawOcadFile): SlimMapObject[] {
  const out: SlimMapObject[] = [];
  for (const obj of file.objects ?? []) {
    const slim = slimObject(obj);
    if (slim) out.push(slim);
  }
  return out;
}

/** The legacy cut features of a parsed OCAD file (radii by the file's own symbols, else the library by `mapScale`). */
export function cutFeaturesOfOcad(file: RawOcadFile, mapScale: number | null): course.CutFeature[] {
  const radii = file.symbols ? course.ocadCutSymbolRadiiMm(file.symbols, file.header?.version) : new Map<number, number>();
  return cutFeaturesOfSlimObjects(slimObjectsOfOcad(file), radii, mapScale);
}

/** OCAD units per paper mm (SlimMapObject coordinates). */
const UNITS_PER_MM = 100;

/** `204000` → `"204"`, `203001` → `"203.1"` (OCAD stores sub-codes in the last three digits). */
function ocadCode(sym: number): string {
  const main = Math.floor(sym / 1000);
  const sub = sym % 1000;
  return sub ? `${main}.${sub}` : String(main);
}

/**
 * Cut features of the OCAD point objects whose code is in `CUT_CODES`
 * (`docs/course-editor.md` "Automatic overprint cuts"). `fileRadii` are
 * the file's own symbol sizes by `sym`; a symbol without one is measured
 * in the library `mapScale` picks (03 §6.5; null = the reference scale).
 */
export function cutFeaturesOfSlimObjects(
  objects: SlimMapObject[],
  fileRadii: ReadonlyMap<number, number>,
  mapScale: number | null,
): course.CutFeature[] {
  const { libraryId, documentFactor } = course.cutContextForScale(mapScale && mapScale > 0 ? mapScale : 15000);
  const radius = new Map<number, number>();
  const out: course.CutFeature[] = [];
  for (const obj of objects) {
    if (obj.objType !== 1 || !course.CUT_CODES.has(Math.floor(obj.sym / 1000))) continue;
    const p = obj.coordinates[0];
    if (!p) continue;
    let r = radius.get(obj.sym);
    if (r === undefined) {
      r = fileRadii.get(obj.sym) ?? course.cutSymbolRadiusMm(libraryId, ocadCode(obj.sym)) * documentFactor;
      radius.set(obj.sym, r);
    }
    out.push({ x: p[0] / UNITS_PER_MM, y: p[1] / UNITS_PER_MM, r });
  }
  return out;
}

/** The fork's `readOcad` result as the shared normaliser sees it. */
type OcadParsed = mapImport.OcadFileLike;

async function readOcadQuiet(buffer: Buffer): Promise<OcadParsed | null> {
  try {
    const ocadMod = await import("ocad2geojson");
    const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
      buf: Buffer,
      opts?: Record<string, unknown>,
    ) => Promise<OcadParsed>;
    return await readOcad(buffer, { quietWarnings: true });
  } catch {
    return null;
  }
}

const NO_METADATA: MapFileMetadata = { scale: null, bounds: null, northOffset: null, calibration: null };

/**
 * The quick-access columns as the upload derived them from the OCAD file
 * until E5 (`event-map.ts` `parseOcadMapMetadata`): the shared normaliser's
 * frame, the meridian tilt and `rotationCorrectionDeg` through the pin's
 * own column function, with the legacy CRS inference for a file whose
 * document has no CRS. Corrupt buffers give nulls.
 */
export async function parseOcadMapMetadata(buffer: Buffer, rotationCorrectionDeg = 0): Promise<MapFileMetadata> {
  const ocad = await readOcadQuiet(buffer);
  if (!ocad) return NO_METADATA;
  try {
    const { input, analysis } = mapImport.ocadToDocumentInput(ocad, { fileName: "", fileHash: "", fileBytes: 0, renderFor: () => null });
    const frame = {
      unitsPerMm: input.header.unitsPerMm,
      mapScale: input.header.mapScale,
      georeferencing: input.header.georeferencing,
      bounds: analysis.bounds,
    };
    const tilt = analysis.north.meridian?.medianTiltDeg ?? null;
    const metadata = mapFileMetadataFor(frame, tilt, rotationCorrectionDeg);
    if (metadata) return metadata as MapFileMetadata;
    // The fork's CRS object, as `event-crs.ts` reads it for the legacy inference.
    const crs = ocad.getCrs?.();
    const legacy = crs ? frameFromOcadCrs(crs as unknown as OcadCrs) : null;
    const inferred = legacy
      ? mapFileMetadataFor({ ...frame, georeferencing: legacy.georeferencing }, tilt, rotationCorrectionDeg)
      : null;
    return (inferred as MapFileMetadata | null) ?? { ...NO_METADATA, scale: frame.mapScale };
  } catch {
    return NO_METADATA;
  }
}
