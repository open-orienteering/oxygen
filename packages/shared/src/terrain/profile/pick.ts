/**
 * Which height field climb is read from (docs/course-elevation.md §3).
 */

/** What the picker reads of a provider (`HeightFieldProvider`, docs/map-terrain.md §5.1). */
export interface ClimbProviderLike {
  id: string;
  grade: "anchor" | "coarse";
  attribution: string;
  licence?: string;
}

/** The contour interval: the one the contour field was derived at (the scale guess) and the one a person confirmed (§3, §0.43). */
export interface ClimbIntervalLike {
  assumedM: number;
  confirmedM: number | null;
}

/** `course.mapMetadata.terrain`, the part the picker reads (docs/map-storage.md §4.7 "Descriptor"). */
export interface ClimbTerrainLike {
  state: "ready" | "none" | "over-cap" | "pending";
  url: string | null;
  /** The map's contour interval; absent in a descriptor cached before it existed, which reads as not confirmed. */
  interval?: ClimbIntervalLike | null;
  /** Absent in a descriptor cached before H10. */
  dem?: {
    state: "ready" | "pending" | "unavailable" | "failed" | "disabled";
    provider: ClimbProviderLike | null;
    ground: { url: string } | null;
    anchored: { url: string } | null;
  } | null;
}

/** What a number rests on: a ground model, or the map's contours. */
export type ClimbBasis = "ground" | "contours";

export interface ClimbFieldPick {
  url: string;
  basis: ClimbBasis;
  /** The provider whose heights the field holds (attribution); null for the plain contour field. */
  provider: ClimbProviderLike | null;
  /**
   * With basis `contours` and an interval in the descriptor: the interval to read the heights at
   * (`confirmedM` when there is one, else the assumed one) and whether a person confirmed it.
   * Without it the pick is unconfirmed.
   */
  interval?: { m: number; confirmed: boolean };
}

/**
 * First match: an anchor-grade ground model, the DEM-anchored contour
 * field, the plain contour field; null without a field. A coarse ground
 * model (a 30 m surface model) is never read for climb. The anchored
 * field is read only at the interval it was derived at (an anchored
 * field is not linear in the interval); with another confirmed one the
 * plain contour field is, its heights scaled (`fieldSampler`).
 */
export function pickClimbField(terrain: ClimbTerrainLike | null | undefined): ClimbFieldPick | null {
  if (!terrain) return null;
  const iv = terrain.interval ?? null;
  const interval = iv ? { interval: { m: iv.confirmedM ?? iv.assumedM, confirmed: iv.confirmedM !== null } } : {};
  const dem = terrain.dem;
  if (dem?.state === "ready" && dem.provider) {
    if (dem.ground && dem.provider.grade === "anchor") return { url: dem.ground.url, basis: "ground", provider: dem.provider };
    if (dem.anchored && (!iv || iv.confirmedM === null || iv.confirmedM === iv.assumedM)) return { url: dem.anchored.url, basis: "contours", provider: dem.provider, ...interval };
  }
  if ((terrain.state === "ready" || terrain.state === "pending") && terrain.url) return { url: terrain.url, basis: "contours", provider: null, ...interval };
  return null;
}
