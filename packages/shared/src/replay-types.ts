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
  /**
   * Id of the {@link ReplayCourse} (fork) this runner actually ran. Only set
   * for forked relay legs, where it is recovered by matching the runner's
   * punched control sequence against each fork. Absent for non-forked events.
   */
  courseId?: string;
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
  /**
   * Stable id for the course. For forked relay legs each fork is a distinct
   * course with its own id; {@link ReplayRoute.courseId} references it.
   */
  id: string;
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

/** One relay leg of a multi-leg class. */
export interface ReplayRelayLeg {
  /** 1-based leg number. */
  leg: number;
  /** Display name (usually the leg number as a string). */
  name: string;
  /** Number of participants on this leg. */
  participantCount: number;
}

/**
 * Relay metadata for multi-leg classes. Present only when the loaded class
 * has more than one relay leg; drives the leg switcher in the viewer. Each
 * leg is loaded lazily as its own {@link ReplayData} (own map + forks +
 * runners), so this just describes the available legs and which one is loaded.
 */
export interface ReplayRelayInfo {
  legs: ReplayRelayLeg[];
  /** The leg number this dataset was loaded for. */
  currentLeg: number;
}

/** Complete replay dataset. */
export interface ReplayData {
  title: string;
  sourceType: "oxygen" | "gpx";
  map: ReplayMap;
  /**
   * Course definitions. A single course for a normal event; one entry per
   * fork for a forked relay leg.
   */
  courses: ReplayCourse[];
  routes: ReplayRoute[];
  /** Absolute epoch ms of the earliest route start. Used for real-time mode. */
  referenceTimeMs: number;
  /** Relay leg metadata; absent for non-relay classes. */
  relay?: ReplayRelayInfo;
}
