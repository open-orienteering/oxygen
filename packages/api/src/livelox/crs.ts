/**
 * Coordinate reference system conversions for Livelox projected route data.
 *
 * Supports:
 *   EPSG:3006 — SWEREF 99 TM (Sweden)
 *   Generic UTM zones
 */

const DEG = Math.PI / 180;

// GRS80 ellipsoid
const A = 6378137.0;
const F = 1 / 298.257222101;
const B = A * (1 - F);
const E2 = (A * A - B * B) / (A * A);
const E_PRIME2 = (A * A - B * B) / (B * B);

interface TMParams {
  centralMeridianDeg: number;
  scaleFactor: number;
  falseEasting: number;
  falseNorthing: number;
}

const CRS_PARAMS: Record<number, TMParams> = {
  // SWEREF 99 TM
  3006: { centralMeridianDeg: 15, scaleFactor: 0.9996, falseEasting: 500000, falseNorthing: 0 },
};

/**
 * Inverse Transverse Mercator: (easting, northing) → (lat, lng) in degrees.
 */
function tmToLatLng(
  easting: number,
  northing: number,
  params: TMParams,
): { lat: number; lng: number } {
  const { centralMeridianDeg, scaleFactor: k0, falseEasting: fe, falseNorthing: fn } = params;
  const lng0 = centralMeridianDeg * DEG;

  const x = (easting - fe) / k0;
  const y = (northing - fn) / k0;

  // Footpoint latitude
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = y;
  const mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));

  const phi1 =
    mu +
    (3 * e1 / 2 - 27 * e1 * e1 * e1 / 32) * Math.sin(2 * mu) +
    (21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 32) * Math.sin(4 * mu) +
    (151 * e1 * e1 * e1 / 96) * Math.sin(6 * mu) +
    (1097 * e1 * e1 * e1 * e1 / 512) * Math.sin(8 * mu);

  const sinPhi = Math.sin(phi1);
  const cosPhi = Math.cos(phi1);
  const tanPhi = Math.tan(phi1);
  const N1 = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const T1 = tanPhi * tanPhi;
  const C1 = E_PRIME2 * cosPhi * cosPhi;
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sinPhi * sinPhi, 1.5);
  const D = x / N1;

  const lat =
    phi1 -
    ((N1 * tanPhi) / R1) *
      (D * D / 2 -
        (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * E_PRIME2) * D * D * D * D / 24 +
        (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * E_PRIME2 - 3 * C1 * C1) *
          D * D * D * D * D * D / 720);

  const lng =
    lng0 +
    (D -
      (1 + 2 * T1 + C1) * D * D * D / 6 +
      (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * E_PRIME2 + 24 * T1 * T1) *
        D * D * D * D * D / 120) /
      cosPhi;

  return { lat: lat / DEG, lng: lng / DEG };
}

/**
 * Get a converter function for a given EPSG code.
 * Returns a function that converts (easting, northing) → {lat, lng},
 * or null if the CRS is not supported.
 */
export function getProjectedToLatLng(
  epsgCode: number,
): ((easting: number, northing: number) => { lat: number; lng: number }) | null {
  const params = CRS_PARAMS[epsgCode];
  if (!params) return null;
  return (easting, northing) => tmToLatLng(easting, northing, params);
}

/**
 * Forward Transverse Mercator: (lat, lng) in degrees → (easting, northing).
 */
export function latLngToTM(
  latDeg: number,
  lngDeg: number,
  epsgCode: number,
): { easting: number; northing: number } | null {
  const params = CRS_PARAMS[epsgCode];
  if (!params) return null;
  const { centralMeridianDeg, scaleFactor: k0, falseEasting: fe, falseNorthing: fn } = params;

  const lat = latDeg * DEG;
  const lng = lngDeg * DEG;
  const lng0 = centralMeridianDeg * DEG;

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = E_PRIME2 * cosLat * cosLat;
  const Adiff = cosLat * (lng - lng0);

  const M =
    A *
    ((1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256) * lat -
      (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 * E2 * E2 / 1024) * Math.sin(2 * lat) +
      (15 * E2 * E2 / 256 + 45 * E2 * E2 * E2 / 1024) * Math.sin(4 * lat) -
      (35 * E2 * E2 * E2 / 3072) * Math.sin(6 * lat));

  const easting =
    fe +
    k0 * N *
      (Adiff +
        (1 - T + C) * Adiff * Adiff * Adiff / 6 +
        (5 - 18 * T + T * T + 72 * C - 58 * E_PRIME2) * Adiff * Adiff * Adiff * Adiff * Adiff / 120);

  const northing =
    fn +
    k0 *
      (M +
        N * tanLat *
          (Adiff * Adiff / 2 +
            (5 - T + 9 * C + 4 * C * C) * Adiff * Adiff * Adiff * Adiff / 24 +
            (61 - 58 * T + T * T + 600 * C - 330 * E_PRIME2) * Adiff * Adiff * Adiff * Adiff * Adiff * Adiff / 720));

  return { easting, northing };
}
