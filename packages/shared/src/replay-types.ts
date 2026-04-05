/** Source-agnostic replay data types for GPS route visualization. */

/** A single timestamped GPS position. */
export interface ReplayWaypoint {
  /** Absolute time in milliseconds (epoch or source-specific reference). */
  timeMs: number;
  lat: number;
  lng: number;
}

/** A participant's GPS route. */
export interface ReplayRoute {
  participantId: string;
  name: string;
  organisation?: string;
  color?: string;
  waypoints: ReplayWaypoint[];
  /** Waypoint indices where GPS signal was interrupted (gap before this index). */
  interruptions: number[];
  /**
   * Actual race start time in the same timebase as waypoints (ms).
   * May differ from the first waypoint if GPS recording started before the race.
   * Used for mass-start alignment.
   */
  raceStartMs?: number;
  result?: ReplayResult;
}

export interface ReplayResult {
  status: "ok" | "mp" | "dnf" | "dns" | "dq" | "unknown";
  /** Total time in milliseconds. */
  timeMs?: number;
  rank?: number;
  splitTimes?: ReplaySplitTime[];
}

export interface ReplaySplitTime {
  controlCode: string;
  /** Split time in milliseconds from start. */
  timeMs: number;
}

/** A control point on the course. */
export interface ReplayControl {
  code: string;
  type: "start" | "control" | "finish";
  lat: number;
  lng: number;
}

/** Course definition — ordered sequence of controls. */
export interface ReplayCourse {
  name: string;
  controls: ReplayControl[];
  /** Course length in meters (if known). */
  lengthM?: number;
}

/**
 * Affine projection mapping (lat,lng) relative to an origin → map pixel coords.
 *
 * The transform is:
 *   dLat = (lat - originLat) * 1e6
 *   dLng = (lng - originLng) * 1e6
 *   px = a * dLng + b * dLat + tx
 *   py = c * dLng + d * dLat + ty
 *
 * The matrix stores [a, b, tx, c, d, ty] (row-major, top two rows of a 3×3).
 */
export interface ReplayProjection {
  matrix: [number, number, number, number, number, number];
  originLat: number;
  originLng: number;
}

/** Map tile positioned by pixel offset on the full map image. */
export interface ReplayMapTile {
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
}

/** Map image definition — supports both single-image and tiled maps. */
export interface ReplayMap {
  widthPx: number;
  heightPx: number;
  projection: ReplayProjection;
  /** Map scale denominator (e.g. 15000 for a 1:15000 map). */
  mapScale?: number;
  /** Rotation of map image relative to true north (degrees, CW positive). */
  rotation?: number;
  /** Single full-resolution image URL. */
  imageUrl?: string;
  /** Tiled map (array of positioned tile images). */
  tiles?: ReplayMapTile[];
}

/** Complete replay dataset. */
export interface ReplayData {
  title: string;
  sourceType: "livelox" | "oxygen" | "gpx";
  map: ReplayMap;
  courses: ReplayCourse[];
  routes: ReplayRoute[];
  /** Absolute epoch ms of the earliest route start. Used for real-time mode. */
  referenceTimeMs: number;
}
