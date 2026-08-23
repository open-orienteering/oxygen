/**
 * Client-side affine projection math for the replay viewer.
 *
 * Converts between WGS84 (lat,lng) and map pixel coordinates using
 * the affine transform stored in ReplayProjection.
 *
 * The projection works in a local coordinate system centred on the
 * origin point, so it stays accurate over the extent of a single map
 * without needing a full CRS implementation.
 */

import type { ReplayProjection } from "@oxygen/shared";

/** Convert (lat, lng) → map pixel (px, py). */
export function latLngToMapPx(
  lat: number,
  lng: number,
  proj: ReplayProjection,
): { px: number; py: number } {
  const [a, b, tx, c, d, ty] = proj.matrix;
  const dLng = lng - proj.originLng;
  const dLat = lat - proj.originLat;

  // The matrix maps metre offsets from the origin to pixel coordinates,
  // so the degree deltas are converted to metres first. A flat-earth
  // approximation is fine at map scale (a few km at most).
  const DEG_TO_M_LAT = 111320; // metres per degree latitude (approx)
  const cosLat = Math.cos((proj.originLat * Math.PI) / 180);
  const DEG_TO_M_LNG = 111320 * cosLat;

  const dxM = dLng * DEG_TO_M_LNG;
  const dyM = dLat * DEG_TO_M_LAT;

  const px = a * dxM + b * dyM + tx;
  const py = c * dxM + d * dyM + ty;

  return { px, py };
}

/**
 * True if a projected map-pixel position is plausibly on (or near) the map
 * image.
 *
 * Used to reject pathological coordinates before they can drag the
 * follow-camera bounding box off the map — e.g. a single glitchy GPS
 * sample, or (defence in depth) an unsupported CRS that slipped through and
 * got mis-decoded as raw lat/lng, placing a runner ~1000 km away. The
 * generous one-map-dimension margin keeps legitimate just-off-the-edge
 * positions while excluding wildly-wrong ones.
 */
export function isOnMap(
  px: number,
  py: number,
  mapW: number,
  mapH: number,
  marginFactor = 1,
): boolean {
  return (
    Number.isFinite(px) &&
    Number.isFinite(py) &&
    px >= -marginFactor * mapW &&
    px <= mapW + marginFactor * mapW &&
    py >= -marginFactor * mapH &&
    py <= mapH + marginFactor * mapH
  );
}

/** Clamp a viewport centre (in map pixels) to the map image bounds. */
export function clampToMap(
  cx: number,
  cy: number,
  mapW: number,
  mapH: number,
): { cx: number; cy: number } {
  return {
    cx: Math.min(Math.max(cx, 0), mapW),
    cy: Math.min(Math.max(cy, 0), mapH),
  };
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
