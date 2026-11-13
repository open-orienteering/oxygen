/**
 * The stored GPS track and its trim and split (docs/map-gps-tracks.md
 * §2.1, §3.5). A track is kept in WGS 84 so a re-match or a new map
 * edition does not move it (SLICES.md slice G, "Decided in this split");
 * it is projected onto a map's paper whenever it is drawn, edited or
 * converted (`project.ts`).
 *
 * `TrackPoints` is columnar and integer so a track parsed on the device
 * and the same track read back from `map_gps_tracks.points` (G24) are the
 * same input to the geometry and to averaging.
 */

/** Columns of equal length (`time` / `ele` may be null as a whole). */
export interface TrackPoints {
  /** Latitude, integer 1e-7 degrees (`Math.round(deg * 1e7)`). */
  lat: number[];
  /** Longitude, integer 1e-7 degrees. */
  lng: number[];
  /** Epoch ms UTC, integer; a point without a time is null; the column is null when no point has one. */
  time: (number | null)[] | null;
  /** Metres, rounded to 0.1; null per point / column as `time`. */
  ele: (number | null)[] | null;
}

export interface Track {
  name: string | null;
  points: TrackPoints;
}

/** Point indices: `start` inclusive, `end` exclusive (the trim G24 stores and G27's handles set). */
export interface TrackRange {
  start: number;
  end: number;
}

export const COORD_SCALE = 1e7;

/** Degrees → the stored integer 1e-7 degrees. */
export function quantiseDeg(deg: number): number {
  return Math.round(deg * COORD_SCALE);
}

/** Metres → the stored elevation (0.1 m). */
export function quantiseEle(m: number): number {
  return Math.round(m * 10) / 10;
}

/** Number of points. */
export function trackLength(t: Track): number {
  return t.points.lat.length;
}

function sliceColumns(p: TrackPoints, start: number, end: number): TrackPoints {
  return {
    lat: p.lat.slice(start, end),
    lng: p.lng.slice(start, end),
    time: p.time ? p.time.slice(start, end) : null,
    ele: p.ele ? p.ele.slice(start, end) : null,
  };
}

/** Keep points `[start, end)` — at least two. Every column is sliced alike. */
export function trimTrack<T extends Track>(track: T, range: TrackRange): T {
  const n = trackLength(track);
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > n || end - start < 2) {
    throw new RangeError(`Trim [${start}, ${end}) of a ${n}-point track must keep at least two points`);
  }
  return { ...track, points: sliceColumns(track.points, start, end) };
}

/**
 * Split at `index` into points `[0, index]` and `[index, n − 1]`: the
 * split point is in both parts, so they touch, and cutting out a break is
 * split, split, delete the middle. `index` must be 1 … n − 2.
 */
export function splitTrack<T extends Track>(track: T, index: number): [T, T] {
  const n = trackLength(track);
  if (!Number.isInteger(index) || index < 1 || index > n - 2) {
    throw new RangeError(`Splitting a ${n}-point track at ${index} must leave two points on each side`);
  }
  return [
    { ...track, points: sliceColumns(track.points, 0, index + 1) },
    { ...track, points: sliceColumns(track.points, index, n) },
  ];
}
