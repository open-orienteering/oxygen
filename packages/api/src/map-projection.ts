/**
 * Coordinate conversion utilities for OCAD maps.
 *
 * Converts from OCAD paper coordinates (hundredths of mm) through
 * a national grid projection (e.g. SWEREF99 TM) to WGS84 lat/lng.
 *
 * The conversion chain:
 *   OCAD internal (1/100 mm on paper)
 *     → CRS.toProjectedCoord() → national grid (meters)
 *     → proj4 (EPSG:XXXX → EPSG:4326) → WGS84 [lng, lat]
 */

import proj4 from "proj4";

// ─── proj4 projection definitions ────────────────────────────
// proj4 only knows EPSG:4326 and EPSG:3857 by default.
// We register Nordic + common projections that OCAD maps use.

// Sweden
proj4.defs("EPSG:3006", "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3007", "+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3008", "+proj=tmerc +lat_0=0 +lon_0=13.5 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3009", "+proj=tmerc +lat_0=0 +lon_0=15 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3010", "+proj=tmerc +lat_0=0 +lon_0=16.5 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3011", "+proj=tmerc +lat_0=0 +lon_0=18 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3012", "+proj=tmerc +lat_0=0 +lon_0=14.25 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3013", "+proj=tmerc +lat_0=0 +lon_0=15.75 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3014", "+proj=tmerc +lat_0=0 +lon_0=17.25 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3015", "+proj=tmerc +lat_0=0 +lon_0=18.75 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3016", "+proj=tmerc +lat_0=0 +lon_0=20.25 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3017", "+proj=tmerc +lat_0=0 +lon_0=21.75 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:3018", "+proj=tmerc +lat_0=0 +lon_0=23.25 +k=1 +x_0=150000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

// Finland
proj4.defs("EPSG:3067", "+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

// Norway (NGO zones + UTM)
proj4.defs("EPSG:25832", "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:25833", "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:25834", "+proj=utm +zone=34 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
proj4.defs("EPSG:25835", "+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

// WGS84 UTM zones (commonly used in Nordic countries)
for (let zone = 32; zone <= 36; zone++) {
  const code = 32600 + zone;
  proj4.defs(`EPSG:${code}`, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
}

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

export interface WGS84Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

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
  const epsg = getEpsgString(crs);
  if (!epsg) return null;

  const projected = crs.toProjectedCoord([xHundredthsMm, yHundredthsMm]);
  const [lng, lat] = proj4(epsg, "EPSG:4326", projected);
  return { lat, lng };
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
  const epsg = getEpsgString(crs);
  if (!epsg) return null;

  const [minX, minY, maxX, maxY] = bounds;
  const corners = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ];

  const wgs84Points = corners.map((c) => {
    const projected = crs.toProjectedCoord(c);
    return proj4(epsg, "EPSG:4326", projected);
  });

  return {
    north: Math.max(...wgs84Points.map((p) => p[1])),
    south: Math.min(...wgs84Points.map((p) => p[1])),
    east: Math.max(...wgs84Points.map((p) => p[0])),
    west: Math.min(...wgs84Points.map((p) => p[0])),
  };
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
  const epsg = getEpsgString(crs);
  if (!epsg) return null;

  // WGS84 → projected (national grid meters)
  const [projX, projY] = proj4("EPSG:4326", epsg, [lng, lat]);

  // Reverse the affine transform in toProjectedCoord:
  //   Forward: rotated = rotate(ocad, -grivation)
  //            projected = rotated * (scale / 100000) + [easting, northing]
  //   Inverse: rotated = (projected - [easting, northing]) / (scale / 100000)
  //            ocad = rotate(rotated, +grivation)
  const hundredsMmToMeter = 1 / (100 * 1000);
  const scaleFactor = crs.scale * hundredsMmToMeter;
  const rx = (projX - crs.easting) / scaleFactor;
  const ry = (projY - crs.northing) / scaleFactor;

  // Un-rotate by +grivation (inverse of forward's -grivation)
  const cosG = Math.cos(crs.grivation);
  const sinG = Math.sin(crs.grivation);
  const ocadX = rx * cosG - ry * sinG;
  const ocadY = rx * sinG + ry * cosG;

  return { x: ocadX, y: ocadY };
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
  const [minX, minY, maxX, maxY] = bounds;
  const midX = (minX + maxX) / 2;
  // Two points on the same OCAD vertical line (same X), separated in Y
  const p1 = ocadToWgs84(midX, minY + (maxY - minY) * 0.25, crs);
  const p2 = ocadToWgs84(midX, minY + (maxY - minY) * 0.75, crs);
  if (!p1 || !p2) return null;

  // Compute bearing from p1 to p2
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const lat1r = p1.lat * Math.PI / 180;
  const lat2r = p2.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2r);
  const x = Math.cos(lat1r) * Math.sin(lat2r) -
    Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLng);
  return Math.atan2(y, x) * 180 / Math.PI;
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
 * Get the EPSG string for a CRS, or null if unsupported.
 */
function getEpsgString(crs: OcadCrs): string | null {
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

  const epsg = `EPSG:${code}`;

  // Check if proj4 knows this projection
  try {
    proj4(epsg);
  } catch {
    console.warn(
      `[map-projection] proj4 does not have a definition for ${epsg}. Add it to map-projection.ts.`,
    );
    return null;
  }

  return epsg;
}
