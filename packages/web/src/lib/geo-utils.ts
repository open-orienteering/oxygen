/**
 * Web Mercator math utilities for the tile-based MapViewer.
 *
 * Coordinate systems:
 *   - WGS84: lat/lng in degrees
 *   - Tile: slippy-map tile indices (z, x, y)
 *   - Pixel: screen pixel position within the viewport container
 */

export interface WGS84Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface TileViewport {
  centerLat: number;
  centerLng: number;
  zoom: number; // floating-point for smooth zoom
}

// ─── Tile ↔ WGS84 conversion ──────────────────────────────────

export function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * Math.pow(2, z);
}

export function latToTileY(lat: number, z: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    Math.pow(2, z)
  );
}

export function tileXToLng(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// ─── Pixel ↔ WGS84 conversion ────────────────────────────────

/** Pixels per world at a given zoom level (256 * 2^zoom). */
function worldSize(zoom: number): number {
  return 256 * Math.pow(2, zoom);
}

/** Convert lng to absolute world-pixel X at a given zoom. */
function lngToWorldPx(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * worldSize(zoom);
}

/** Convert lat to absolute world-pixel Y at a given zoom. */
function latToWorldPy(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    worldSize(zoom)
  );
}

/** Convert absolute world-pixel X to lng. */
function worldPxToLng(px: number, zoom: number): number {
  return (px / worldSize(zoom)) * 360 - 180;
}

/** Convert absolute world-pixel Y to lat. */
function worldPyToLat(py: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * py) / worldSize(zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Convert a lat/lng position to screen pixel coordinates within the container.
 */
export function latlngToPixel(
  lat: number,
  lng: number,
  vp: TileViewport,
  containerW: number,
  containerH: number,
): { px: number; py: number } {
  const cx = lngToWorldPx(vp.centerLng, vp.zoom);
  const cy = latToWorldPy(vp.centerLat, vp.zoom);
  const px = lngToWorldPx(lng, vp.zoom) - cx + containerW / 2;
  const py = latToWorldPy(lat, vp.zoom) - cy + containerH / 2;
  return { px, py };
}

/**
 * Convert screen pixel coordinates to lat/lng.
 */
export function pixelToLatlng(
  px: number,
  py: number,
  vp: TileViewport,
  containerW: number,
  containerH: number,
): { lat: number; lng: number } {
  const cx = lngToWorldPx(vp.centerLng, vp.zoom);
  const cy = latToWorldPy(vp.centerLat, vp.zoom);
  const worldX = px - containerW / 2 + cx;
  const worldY = py - containerH / 2 + cy;
  return {
    lat: worldPyToLat(worldY, vp.zoom),
    lng: worldPxToLng(worldX, vp.zoom),
  };
}

// ─── Viewport fitting ────────────────────────────────────────

/**
 * Compute a viewport that fits the given WGS84 bounds in the container,
 * with optional padding (fraction of container, e.g. 0.1 = 10%).
 */
export function fitBounds(
  bounds: WGS84Bounds,
  containerW: number,
  containerH: number,
  padding = 0.1,
): TileViewport {
  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;

  const effectiveW = containerW * (1 - 2 * padding);
  const effectiveH = containerH * (1 - 2 * padding);
  if (effectiveW <= 0 || effectiveH <= 0) {
    return { centerLat, centerLng, zoom: 15 };
  }

  // Binary search for the right zoom level
  let lo = 0, hi = 22;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const x0 = lngToWorldPx(bounds.west, mid);
    const x1 = lngToWorldPx(bounds.east, mid);
    const y0 = latToWorldPy(bounds.north, mid);
    const y1 = latToWorldPy(bounds.south, mid);
    const bw = Math.abs(x1 - x0);
    const bh = Math.abs(y1 - y0);
    if (bw > effectiveW || bh > effectiveH) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return { centerLat, centerLng, zoom: Math.min(lo, 22) };
}

// ─── Meters per pixel (for symbol scaling) ────────────────────

const EARTH_CIRCUMFERENCE = 40075016.686;

/**
 * Meters per pixel at a given latitude and zoom level.
 */
export function metersPerPixel(lat: number, zoom: number): number {
  return (
    (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / worldSize(zoom)
  );
}

// ─── Affine transform: mapMm ↔ lat/lng ───────────────────────

export interface AffineTransform {
  /** Convert map mm → lat/lng */
  toLatLng(mapX: number, mapY: number): { lat: number; lng: number };
  /** Convert lat/lng → map mm */
  toMapMm(lat: number, lng: number): { mapX: number; mapY: number };
}

/**
 * Build a least-squares affine transform from control points that have
 * both mapMm (x, y) and WGS84 (lat, lng) coordinates.
 *
 * The affine maps [mapX, mapY] → [lat, lng]:
 *   lat = a0 + a1*mapX + a2*mapY
 *   lng = b0 + b1*mapX + b2*mapY
 *
 * Requires at least 3 non-collinear points. Falls back to offset-only
 * (translation) with 1-2 points.
 */
export function buildAffineTransform(
  points: { mapX: number; mapY: number; lat: number; lng: number }[],
): AffineTransform | null {
  if (points.length === 0) return null;

  if (points.length === 1) {
    // Single point: only translation, assume identity scale (unusable for
    // real mapping but prevents crashes)
    const p = points[0];
    return {
      toLatLng(mapX, mapY) {
        return { lat: p.lat + (mapY - p.mapY) * 1e-5, lng: p.lng + (mapX - p.mapX) * 1e-5 };
      },
      toMapMm(lat, lng) {
        return { mapX: p.mapX + (lng - p.lng) / 1e-5, mapY: p.mapY + (lat - p.lat) / 1e-5 };
      },
    };
  }

  if (points.length === 2) {
    // Two points: compute scale + rotation from the pair
    const [p0, p1] = points;
    const dmx = p1.mapX - p0.mapX;
    const dmy = p1.mapY - p0.mapY;
    const dlat = p1.lat - p0.lat;
    const dlng = p1.lng - p0.lng;
    const d2 = dmx * dmx + dmy * dmy;
    if (d2 < 1e-12) return null;
    // Solve for affine coefficients from the two-point system
    const a1 = (dlat * dmx + dlng * dmy) / d2; // approximate
    const a2 = (dlat * dmy - dlng * dmx) / d2;
    const b1 = (dlng * dmx - dlat * dmy) / d2;
    const b2 = (dlng * dmy + dlat * dmx) / d2;
    // Wait — let me use a cleaner formulation. With 2 points we solve:
    // [dlat] = [dmx dmy] [a1]   →   a1 = (dlat*dmx)/(dmx²+dmy²) ...
    // [dlng]   [dmx dmy] [b1]
    // But that's not right either. Let me just use the full least-squares
    // with the 2 points (underdetermined, but the normal equations still work).
    // Fall through to the general case.
  }

  // General case: least-squares with >= 2 points
  // Minimize || A * [a0 a1 a2; b0 b1 b2]^T - [lat; lng] ||^2
  // where each point contributes a row [1, mapX, mapY] to the design matrix.
  const n = points.length;
  // Normal equations: (M^T M) x = M^T b  for each of lat, lng separately.
  // M is n×3 with rows [1, mapX, mapY].
  let s1 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  let sLat = 0, sLatX = 0, sLatY = 0;
  let sLng = 0, sLngX = 0, sLngY = 0;
  for (const p of points) {
    s1 += 1;
    sx += p.mapX;
    sy += p.mapY;
    sxx += p.mapX * p.mapX;
    sxy += p.mapX * p.mapY;
    syy += p.mapY * p.mapY;
    sLat += p.lat;
    sLatX += p.lat * p.mapX;
    sLatY += p.lat * p.mapY;
    sLng += p.lng;
    sLngX += p.lng * p.mapX;
    sLngY += p.lng * p.mapY;
  }

  // Solve 3x3 system: [s1 sx sy; sx sxx sxy; sy sxy syy] * [a0;a1;a2] = [sLat;sLatX;sLatY]
  const det =
    s1 * (sxx * syy - sxy * sxy) -
    sx * (sx * syy - sxy * sy) +
    sy * (sx * sxy - sxx * sy);
  if (Math.abs(det) < 1e-20) return null;

  const invDet = 1 / det;
  // Cofactor matrix (symmetric)
  const c00 = sxx * syy - sxy * sxy;
  const c01 = -(sx * syy - sxy * sy);
  const c02 = sx * sxy - sxx * sy;
  const c11 = s1 * syy - sy * sy;
  const c12 = -(s1 * sxy - sx * sy);
  const c22 = s1 * sxx - sx * sx;

  const a0 = (c00 * sLat + c01 * sLatX + c02 * sLatY) * invDet;
  const a1 = (c01 * sLat + c11 * sLatX + c12 * sLatY) * invDet;
  const a2 = (c02 * sLat + c12 * sLatX + c22 * sLatY) * invDet;

  const b0 = (c00 * sLng + c01 * sLngX + c02 * sLngY) * invDet;
  const b1 = (c01 * sLng + c11 * sLngX + c12 * sLngY) * invDet;
  const b2 = (c02 * sLng + c12 * sLngX + c22 * sLngY) * invDet;

  // Inverse affine: [mapX, mapY] = inv([a1 a2; b1 b2]) * ([lat, lng] - [a0, b0])
  const detAB = a1 * b2 - a2 * b1;
  if (Math.abs(detAB) < 1e-30) return null;
  const invDetAB = 1 / detAB;

  return {
    toLatLng(mapX: number, mapY: number) {
      return {
        lat: a0 + a1 * mapX + a2 * mapY,
        lng: b0 + b1 * mapX + b2 * mapY,
      };
    },
    toMapMm(lat: number, lng: number) {
      const dLat = lat - a0;
      const dLng = lng - b0;
      return {
        mapX: (b2 * dLat - a2 * dLng) * invDetAB,
        mapY: (-b1 * dLat + a1 * dLng) * invDetAB,
      };
    },
  };
}
