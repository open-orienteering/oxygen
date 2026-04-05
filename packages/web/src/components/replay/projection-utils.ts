/**
 * Client-side affine projection math for the replay viewer.
 *
 * Converts between WGS84 (lat,lng) and map pixel coordinates using
 * the affine transform stored in ReplayProjection.
 *
 * The Livelox projection works in a local coordinate system centred on
 * the origin point. Offsets are computed in micro-degrees (×1e6) which
 * gives ~0.1 m resolution — matching the precision of the route data.
 */

import type { ReplayProjection } from "@oxygen/shared";

/** Convert (lat, lng) → map pixel (px, py). */
export function latLngToMapPx(
  lat: number,
  lng: number,
  proj: ReplayProjection,
): { px: number; py: number } {
  const [a, b, tx, c, d, ty] = proj.matrix;
  // The Livelox matrix operates on offsets from the origin in the map's
  // native unit.  From inspecting real data the offsets are in degrees
  // (not micro-degrees) — the matrix itself encodes the scale.
  const dLng = lng - proj.originLng;
  const dLat = lat - proj.originLat;

  // Livelox stores the matrix as mapping (dLng_scaled, dLat_scaled) → pixel.
  // From the viewer JS: the projection converts geoCoordinate to image pixel
  // using: px = a * (lng - originLng) * scale + b * (lat - originLat) * scale + tx
  // where scale ≈ 1e6 / resolution.  However, the actual matrix already
  // includes this scale factor — verified empirically:
  //   control S1 at (58.6412, 16.7903), origin (58.6447, 16.7627)
  //   dLng = 0.0276, dLat = -0.0035
  //   Expected pixel ≈ map edge → the matrix values (~0.78) are per-degree.
  //
  // Actually looking more carefully at the Livelox source, the matrix is
  // applied to (x, y) where x and y are:
  //   x = (lng - originLng) * cos(originLat) * earthCircumference / 360  (meters east)
  //   y = (lat - originLat) * earthCircumference / 360                   (meters north)
  // Then pixel = matrix * [x, y, 1]
  //
  // But wait — from the actual data the matrix entries are ~0.78 and the
  // image is ~3437px wide covering ~0.08° lng.  0.08° × 0.78 = 0.06 — way
  // too small.  So the matrix must expect a different unit.
  //
  // Looking at the Livelox viewer code more carefully:
  //   geoCoordinate → projectedPosition via the map's projection
  // In the route decoder, routes are stored as lat×1e6 / lng×1e6 and
  // projected positions are stored as value/10.  The projection matrix
  // maps from (projected_x, projected_y) — which is NOT raw lat/lng.
  //
  // The Livelox viewer uses a Mercator-like projection internally.  But
  // looking at the control positions in the blob, they have both
  // `position` (lat/lng) and `mapPosition` (x/y) in the map image.
  // The mapPosition values are normalised (0-1 range).
  //
  // Actually the simplest approach: the default projection matrix maps
  // from meter offsets to pixel coords.  Let me verify:
  //   dLng_m = dLng * cos(lat) * 111320
  //   dLat_m = dLat * 111320
  // For control S1: dLng_m = 0.0276 * cos(58.64°) * 111320 ≈ 1598 m
  //                  dLat_m = -0.0035 * 111320 ≈ -389 m
  // px = 0.782 * 1598 + (-0.097) * (-389) + 1719 = 1249 + 38 + 1719 = 3006
  // py = (-0.097) * 1598 + (-0.782) * (-389) + 1205 = -155 + 304 + 1205 = 1354
  // Map is 3437×2409.  S1 is near the right edge → px≈3006 looks right!

  const DEG_TO_M_LAT = 111320; // metres per degree latitude (approx)
  const cosLat = Math.cos((proj.originLat * Math.PI) / 180);
  const DEG_TO_M_LNG = 111320 * cosLat;

  const dxM = dLng * DEG_TO_M_LNG;
  const dyM = dLat * DEG_TO_M_LAT;

  const px = a * dxM + b * dyM + tx;
  const py = c * dxM + d * dyM + ty;

  return { px, py };
}

/** Convert map pixel (px, py) → (lat, lng). Inverse of the affine transform. */
export function mapPxToLatLng(
  px: number,
  py: number,
  proj: ReplayProjection,
): { lat: number; lng: number } {
  const [a, b, tx, c, d, ty] = proj.matrix;

  // Solve: [px - tx] = [a b] [dxM]
  //        [py - ty]   [c d] [dyM]
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) {
    return { lat: proj.originLat, lng: proj.originLng };
  }

  const rpx = px - tx;
  const rpy = py - ty;
  const dxM = (d * rpx - b * rpy) / det;
  const dyM = (-c * rpx + a * rpy) / det;

  const DEG_TO_M_LAT = 111320;
  const cosLat = Math.cos((proj.originLat * Math.PI) / 180);
  const DEG_TO_M_LNG = 111320 * cosLat;

  return {
    lat: proj.originLat + dyM / DEG_TO_M_LAT,
    lng: proj.originLng + dxM / DEG_TO_M_LNG,
  };
}
