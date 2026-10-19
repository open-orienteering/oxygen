/**
 * Paper ↔ projected ↔ WGS 84 for a map document's georeferencing
 * (docs/map-import.md §3.8, docs/map-document-format.md §2.3). One
 * implementation for the import's stage 5, the pins' quick-access
 * columns and the legacy `map-projection.ts` / `map-north.ts` adapters.
 *
 * Paper coordinates are the document's native units, y-up. The affine
 * part is OCAD's and Mapper's alike: rotate by −(grid rotation +
 * correction), scale by `gridScaleFactor · mapScale / (unitsPerMm · 1000)`
 * metres per unit, offset by `paperOrigin`.
 *
 * Results are transcendental (proj4, sin/cos) and never go into the
 * document bytes; they live in the import report and the `map_files`
 * columns (docs/map-import.md §6).
 */

import type { Georeferencing } from "../map-document/header.js";
import { epsgName, proj } from "./epsg.js";

/** The header's georeferencing fields the maths reads (defaults applied when absent: rotation 0, scale factor 1). */
export interface FrameGeoreferencing {
  crs: Georeferencing["crs"];
  paperOrigin: Georeferencing["paperOrigin"];
  gridRotationDeg?: number;
  gridScaleFactor?: number;
}

export interface PaperFrame {
  /** Native paper units per mm: OCAD 100, OMAP 1000. */
  unitsPerMm: number;
  /** Scale denominator. */
  mapScale: number;
  georeferencing: FrameGeoreferencing;
  /** Operator rotation correction (`map_files.rotation_correction`), degrees clockwise, added to the grid rotation. */
  correctionDeg?: number;
}

export interface PaperBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Wgs84Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** A paper-mm ↔ WGS 84 anchor (`map_files.calibration`). */
export interface CalibrationPoint {
  mapX: number;
  mapY: number;
  lat: number;
  lng: number;
}

/** The `map_files` quick-access columns (docs/map-storage.md §6.4). */
export interface MapFileMetadata {
  scale: number | null;
  bounds: Wgs84Bounds | null;
  northOffset: number | null;
  calibration: CalibrationPoint[] | null;
}

const DEG = Math.PI / 180;

/** `"EPSG:<code>"` when the frame is georeferenced in an EPSG CRS proj4 can project, else null. */
export function epsgOf(frame: PaperFrame): string | null {
  const { crs, paperOrigin } = frame.georeferencing;
  if (!crs || !paperOrigin || crs.authority !== "EPSG") return null;
  return epsgName(crs.code);
}

function rotationRad(frame: PaperFrame): number {
  return ((frame.georeferencing.gridRotationDeg ?? 0) + (frame.correctionDeg ?? 0)) * DEG;
}

function metresPerUnit(frame: PaperFrame): number {
  return ((frame.georeferencing.gridScaleFactor ?? 1) * frame.mapScale) / (frame.unitsPerMm * 1000);
}

/** Paper (native units) → projected [easting, northing]; null without a paper origin. */
export function paperToProjected(frame: PaperFrame, x: number, y: number): [number, number] | null {
  const origin = frame.georeferencing.paperOrigin;
  if (!origin) return null;
  const g = -rotationRad(frame);
  const cos = Math.cos(g), sin = Math.sin(g);
  const f = metresPerUnit(frame);
  return [(x * cos - y * sin) * f + origin.x, (x * sin + y * cos) * f + origin.y];
}

/** Projected [easting, northing] → paper (native units); null without a paper origin. */
export function projectedToPaper(frame: PaperFrame, easting: number, northing: number): [number, number] | null {
  const origin = frame.georeferencing.paperOrigin;
  if (!origin) return null;
  const f = metresPerUnit(frame);
  const rx = (easting - origin.x) / f, ry = (northing - origin.y) / f;
  const g = rotationRad(frame);
  const cos = Math.cos(g), sin = Math.sin(g);
  return [rx * cos - ry * sin, rx * sin + ry * cos];
}

export function paperToWgs84(frame: PaperFrame, x: number, y: number): LatLng | null {
  const epsg = epsgOf(frame);
  const p = epsg ? paperToProjected(frame, x, y) : null;
  if (!epsg || !p) return null;
  const [lng, lat] = proj()(epsg, "EPSG:4326", p);
  return { lat, lng };
}

export function wgs84ToPaper(frame: PaperFrame, lat: number, lng: number): { x: number; y: number } | null {
  const epsg = epsgOf(frame);
  if (!epsg) return null;
  const [e, n] = proj()("EPSG:4326", epsg, [lng, lat]);
  const p = projectedToPaper(frame, e, n);
  return p ? { x: p[0], y: p[1] } : null;
}

/**
 * Meridian convergence at the paper origin: the bearing of true north
 * measured from grid north, atan2(Δe, Δn) of a 0.001° step north
 * (negative = true north west of grid north), with the origin in WGS 84.
 */
export function gridConvergence(frame: PaperFrame): { angleDeg: number; lat: number; lng: number } | null {
  const epsg = epsgOf(frame);
  const origin = frame.georeferencing.paperOrigin;
  if (!epsg || !origin) return null;
  try {
    const p = proj();
    const [lng, lat] = p(epsg, "EPSG:4326", [origin.x, origin.y]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const [e2, n2] = p("EPSG:4326", epsg, [lng, lat + 0.001]);
    return { angleDeg: Math.atan2(e2 - origin.x, n2 - origin.y) / DEG, lat, lng };
  } catch {
    return null;
  }
}

/**
 * Bearing from true north of paper +Y (degrees, clockwise positive): the
 * initial great-circle bearing between two points on the vertical centre
 * line of `bounds`, at 25 % and 75 % of its height. Folds in grid
 * rotation, correction and convergence.
 */
export function paperNorthBearingDeg(frame: PaperFrame, bounds: PaperBounds): number | null {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const h = bounds.maxY - bounds.minY;
  const p1 = paperToWgs84(frame, midX, bounds.minY + h * 0.25);
  const p2 = paperToWgs84(frame, midX, bounds.minY + h * 0.75);
  if (!p1 || !p2) return null;
  const dLng = (p2.lng - p1.lng) * DEG;
  const lat1 = p1.lat * DEG, lat2 = p2.lat * DEG;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return Math.atan2(y, x) / DEG;
}

function corners(b: PaperBounds): [number, number][] {
  return [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]];
}

/** WGS 84 box around the four projected corners of `bounds`. */
export function wgs84Bounds(frame: PaperFrame, bounds: PaperBounds): Wgs84Bounds | null {
  const pts: LatLng[] = [];
  for (const [x, y] of corners(bounds)) {
    const p = paperToWgs84(frame, x, y);
    if (!p) return null;
    pts.push(p);
  }
  return {
    north: Math.max(...pts.map((p) => p.lat)),
    south: Math.min(...pts.map((p) => p.lat)),
    east: Math.max(...pts.map((p) => p.lng)),
    west: Math.min(...pts.map((p) => p.lng)),
  };
}

/** Paper-mm ↔ WGS 84 anchors at the corners of `bounds` (min/min, max/min, min/max, max/max). */
export function calibrationCorners(frame: PaperFrame, bounds: PaperBounds): CalibrationPoint[] | null {
  const out: CalibrationPoint[] = [];
  for (const [x, y] of corners(bounds)) {
    const p = paperToWgs84(frame, x, y);
    if (!p) return null;
    out.push({ mapX: x / frame.unitsPerMm, mapY: y / frame.unitsPerMm, lat: p.lat, lng: p.lng });
  }
  return out;
}

/**
 * The `map_files` quick-access columns for a map extent. `northOffset`
 * is the display bearing: paper +Y plus the drawn meridians' in-paper
 * tilt, so the viewer's `-northOffset` rotation makes the meridians
 * vertical (`map-north.ts` `displayNorthOffsetDeg`).
 */
export function mapFileMetadata(frame: PaperFrame, bounds: PaperBounds, meridianTiltDeg: number | null | undefined): MapFileMetadata {
  const paperNorth = paperNorthBearingDeg(frame, bounds);
  return {
    scale: frame.mapScale,
    bounds: wgs84Bounds(frame, bounds),
    northOffset: paperNorth === null ? null : paperNorth + (meridianTiltDeg ?? 0),
    calibration: calibrationCorners(frame, bounds),
  };
}
