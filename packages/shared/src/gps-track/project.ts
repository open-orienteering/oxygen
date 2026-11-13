/**
 * A stored track onto a map's paper and back (docs/map-gps-tracks.md
 * §3.1–3.2). Through `mapGeo.wgs84ToPaper` only — the frame's grid
 * rotation, scale factor and operator correction as the viewer uses them
 * (04 §7 "Georeferenced inputs"). Tracks are stored in WGS 84, so they are
 * projected on every use, onto whichever map is open.
 */

import { epsgOf, paperToWgs84, wgs84ToPaper, type PaperBounds, type PaperFrame } from "../geo/projection.js";
import { COORD_SCALE, quantiseDeg, type Track } from "./track.js";

export type TrackProjectionErrorCode = "not-georeferenced" | "not-projectable";

export class TrackProjectionError extends Error {
  readonly code: TrackProjectionErrorCode;
  /** The point that did not project (`not-projectable`). */
  readonly index?: number;
  constructor(code: TrackProjectionErrorCode, message: string, index?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TrackProjectionError";
    this.code = code;
    if (index !== undefined) this.index = index;
  }
}

/**
 * A line on a map's paper: mm, y up (the course layer's and the viewer's
 * space). Transient, never stored. `metresPerMm` = mapScale / 1000 turns
 * paper mm into ground metres.
 */
export interface ProjectedTrack {
  x: Float64Array;
  y: Float64Array;
  metresPerMm: number;
}

export interface ProjectedResult {
  /** Index-aligned with the track's points: `x[i]`, `y[i]` is point `i` (G27's handles rest on it). */
  track: ProjectedTrack;
  /** Points outside `bounds` — kept, drawn and converted like the others; 0 without `bounds`. */
  outside: number;
}

/** Whether tracks can be placed on this map: a CRS proj4 knows and a paper origin. */
export function isGeoreferenced(frame: PaperFrame): boolean {
  return epsgOf(frame) !== null;
}

/** Ground metres per paper mm at a map scale (the grid scale factor is ignored, as `field.ts` `distanceM` does). */
export function metresPerMm(mapScale: number): number {
  return mapScale / 1000;
}

/** proj4 throws on non-finite input; that is a point that does not project, like a non-finite result. */
function attempt<T>(f: () => T | null): { value: T | null; error?: unknown } {
  try {
    return { value: f() };
  } catch (error) {
    return { value: null, error };
  }
}

function notGeoreferenced(): TrackProjectionError {
  return new TrackProjectionError("not-georeferenced", "The map has no georeference, so a GPS track cannot be placed on it");
}

/**
 * WGS 84 → paper mm. `bounds` (the header's bounds, native units) only
 * counts the points outside the map. Throws `TrackProjectionError`
 * `not-georeferenced` (no CRS, no paper origin, or a code proj4 does not
 * know) or `not-projectable` (a point with no finite position — thrown,
 * not dropped, so the index alignment holds).
 */
export function projectTrack(frame: PaperFrame, track: Track, bounds?: PaperBounds): ProjectedResult {
  if (!isGeoreferenced(frame)) throw notGeoreferenced();
  const { lat, lng } = track.points;
  const n = lat.length;
  const u = frame.unitsPerMm;
  const x = new Float64Array(n), y = new Float64Array(n);
  let outside = 0;
  for (let i = 0; i < n; i++) {
    const { value: q, error } = attempt(() => wgs84ToPaper(frame, lat[i] / COORD_SCALE, lng[i] / COORD_SCALE));
    if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) {
      throw new TrackProjectionError("not-projectable", `Point ${i} does not project onto the map`, i, error);
    }
    if (bounds && (q.x < bounds.minX || q.x > bounds.maxX || q.y < bounds.minY || q.y > bounds.maxY)) outside++;
    x[i] = q.x / u;
    y[i] = q.y / u;
  }
  return { track: { x, y, metresPerMm: metresPerMm(frame.mapScale) }, outside };
}

/**
 * Paper mm → a stored track (untimed, no elevation): how an averaged or
 * edited line goes back to WGS 84 (G23). Same errors as `projectTrack`.
 */
export function unprojectTrack(frame: PaperFrame, line: ProjectedTrack, name: string | null = null): Track {
  if (!isGeoreferenced(frame)) throw notGeoreferenced();
  const n = line.x.length;
  const u = frame.unitsPerMm;
  const lat = new Array<number>(n), lng = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const { value: g, error } = attempt(() => paperToWgs84(frame, line.x[i] * u, line.y[i] * u));
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) {
      throw new TrackProjectionError("not-projectable", `Point ${i} does not project to WGS 84`, i, error);
    }
    lat[i] = quantiseDeg(g.lat);
    lng[i] = quantiseDeg(g.lng);
  }
  return { name, points: { lat, lng, time: null, ele: null } };
}
