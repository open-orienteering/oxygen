/**
 * Coordinate conversion utilities for OCAD maps.
 *
 * Converts from OCAD paper coordinates (hundredths of mm) through
 * a national grid projection (e.g. SWEREF99 TM) to WGS84 lat/lng.
 *
 * The conversion chain:
 *   OCAD internal (1/100 mm on paper)
 *     → rotate by −grivation, scale, offset → national grid (meters)
 *     → proj4 (EPSG:XXXX → EPSG:4326) → WGS84 [lng, lat]
 */

import { mapGeo } from "@oxygen/shared";

// The projection maths and the proj4 EPSG definitions live in
// `@oxygen/shared` `mapGeo` (docs/map-import.md §3.8), shared with the
// import's stage 5. This module adapts the OCAD reader's `getCrs()` to it
// and keeps the legacy-only coordinate-range EPSG inference.

// ─── Types ───────────────────────────────────────────────────

export interface OcadCrs {
  easting: number;
  northing: number;
  scale: number;
  grivation: number; // radians
  code: number;      // EPSG code from crs-grids lookup
  catalog: string;   // "EPSG", "ESRI", etc.
  toProjectedCoord(coord: number[]): number[];
}

/**
 * Return a CRS whose grivation is the file's own plus `correctionDeg`
 * (degrees, clockwise positive). `toProjectedCoord` is reimplemented so
 * it honors the corrected angle — spreading `{...crs, grivation}` would
 * leave the original method closed over the file's grivation.
 *
 * Used for mis-georeferenced club maps whose drawing is magnetic-north-up
 * but ScalePar declares a=0.
 */
export function withGrivationCorrection(
  crs: OcadCrs,
  correctionDeg: number,
): OcadCrs {
  if (!correctionDeg) return crs;
  const grivation = crs.grivation + (correctionDeg * Math.PI) / 180;
  const { easting, northing, scale, code, catalog } = crs;
  return {
    easting,
    northing,
    scale,
    grivation,
    code,
    catalog,
    toProjectedCoord([x, y]: number[]): number[] {
      // Forward (matches ocad2geojson): rotate by -grivation, then
      // scale hundredths-of-mm → meters and offset to grid origin.
      const cosG = Math.cos(-grivation);
      const sinG = Math.sin(-grivation);
      const rx = x * cosG - y * sinG;
      const ry = x * sinG + y * cosG;
      const factor = scale / 100_000;
      return [rx * factor + easting, ry * factor + northing];
    },
  };
}

export type WGS84Bounds = mapGeo.Wgs84Bounds;

/**
 * The shared paper frame for a reader CRS, or null when no EPSG code is
 * usable (`getEpsgString`). OCAD units, grid scale factor 1 — the reader
 * ignores ScalePar `b`, and so does every legacy consumer.
 */
export function frameFromOcadCrs(crs: OcadCrs): mapGeo.PaperFrame | null {
  const epsg = getEpsgString(crs);
  if (!epsg) return null;
  return {
    unitsPerMm: 100,
    mapScale: crs.scale,
    georeferencing: {
      crs: { authority: "EPSG", code: Number(epsg.slice("EPSG:".length)), name: "" },
      paperOrigin: { x: crs.easting, y: crs.northing },
      gridRotationDeg: (crs.grivation * 180) / Math.PI,
      gridScaleFactor: 1,
    },
  };
}

const boundsOf = ([minX, minY, maxX, maxY]: number[]): mapGeo.PaperBounds => ({ minX, minY, maxX, maxY });

// ─── Conversion functions ────────────────────────────────────

/**
 * Convert OCAD paper coordinates (hundredths of mm) to WGS84.
 * Returns [lng, lat] or null if the CRS is not supported.
 */
export function ocadToWgs84(
  xHundredthsMm: number,
  yHundredthsMm: number,
  crs: OcadCrs,
): { lat: number; lng: number } | null {
  const frame = frameFromOcadCrs(crs);
  return frame ? mapGeo.paperToWgs84(frame, xHundredthsMm, yHundredthsMm) : null;
}

/**
 * Convert map-mm coordinates to WGS84.
 * Map-mm are the units used in course geometry GeoJSON (mm on paper).
 */
export function mapMmToWgs84(
  xMm: number,
  yMm: number,
  crs: OcadCrs,
): { lat: number; lng: number } | null {
  // Convert mm to hundredths of mm (OCAD internal unit)
  return ocadToWgs84(xMm * 100, yMm * 100, crs);
}

/**
 * Convert OCAD bounds [minX, minY, maxX, maxY] to WGS84 bounding box.
 * Bounds are in OCAD internal coordinates (hundredths of mm, Y goes up).
 * These come directly from ocadFile.getBounds().
 */
export function ocadBoundsToWgs84(
  bounds: number[],
  crs: OcadCrs,
): WGS84Bounds | null {
  const frame = frameFromOcadCrs(crs);
  return frame ? mapGeo.wgs84Bounds(frame, boundsOf(bounds)) : null;
}

// ─── Tile math ──────────────────────────────────────────────

/**
 * Convert slippy-map tile coordinates to WGS84 bounding box.
 */
export function tileBoundsWgs84(z: number, x: number, y: number): WGS84Bounds {
  const n = Math.pow(2, z);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { north, south, east, west };
}

/**
 * Convert WGS84 [lat, lng] to OCAD internal coordinates (hundredths of mm).
 * Reverse of ocadToWgs84.
 */
export function wgs84ToOcad(
  lat: number,
  lng: number,
  crs: OcadCrs,
): { x: number; y: number } | null {
  const frame = frameFromOcadCrs(crs);
  return frame ? mapGeo.wgs84ToPaper(frame, lat, lng) : null;
}

/**
 * Compute the angle (in degrees) between map north (OCAD Y axis) and true north.
 * Positive = map north is clockwise (east) of true north.
 * This includes both grivation and meridian convergence.
 */
export function computeMapNorthOffset(
  bounds: number[],
  crs: OcadCrs,
): number | null {
  const frame = frameFromOcadCrs(crs);
  return frame ? mapGeo.paperNorthBearingDeg(frame, boundsOf(bounds)) : null;
}

/**
 * Try to infer EPSG code from easting/northing coordinate ranges.
 * Returns the EPSG code number or null.
 */
function inferEpsgFromCoords(easting: number, northing: number): number | null {
  // SWEREF99 TM (EPSG:3006): easting 200000–1000000, northing 6100000–7700000
  if (easting >= 200000 && easting <= 1000000 && northing >= 6100000 && northing <= 7700000) {
    return 3006;
  }
  // ETRS-TM35FIN / Finland (EPSG:3067): easting 50000–800000, northing 6600000–7800000
  if (easting >= 50000 && easting <= 800000 && northing >= 6600000 && northing <= 7800000) {
    return 3067;
  }
  // UTM zone 32N (EPSG:25832): easting 200000–900000, northing 5400000–6500000
  if (easting >= 200000 && easting <= 900000 && northing >= 5400000 && northing <= 6500000) {
    return 25832;
  }
  // UTM zone 33N (EPSG:25833): easting 200000–900000, northing 5400000–7900000
  if (easting >= 200000 && easting <= 900000 && northing >= 5400000 && northing <= 7900000) {
    return 25833;
  }
  return null;
}

/**
 * Get the EPSG string for a CRS, or null if unsupported. Falls back to a
 * coordinate-range inference when the file declares no grid code, so
 * every WGS84 conversion in the API (bounds, controls, north analysis)
 * agrees on the projection.
 */
export function getEpsgString(crs: OcadCrs): string | null {
  let code = crs.code;

  // Some OCAD files lack a grid code but have valid easting/northing.
  // Try to infer the CRS from coordinate ranges.
  if (!code || code === 0) {
    const inferred = inferEpsgFromCoords(crs.easting, crs.northing);
    if (inferred) {
      console.info(`[map-projection] Inferred EPSG:${inferred} from easting=${crs.easting}, northing=${crs.northing}`);
      code = inferred;
    } else {
      console.warn(
        `[map-projection] Unsupported OCAD grid: code=${crs.code}, catalog=${crs.catalog}, easting=${crs.easting}, northing=${crs.northing}. Cannot convert to WGS84.`,
      );
      return null;
    }
  }

  const epsg = mapGeo.epsgName(code);
  if (!epsg) {
    console.warn(
      `[map-projection] proj4 does not have a definition for EPSG:${code}. Add it to packages/shared/src/geo/epsg.ts.`,
    );
  }
  return epsg;
}
