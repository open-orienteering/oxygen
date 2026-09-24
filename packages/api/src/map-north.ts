/**
 * North analysis for OCAD maps: locate the drawn magnetic-north lines
 * (ISOM 601.x), measure their in-paper tilt, and compare them with the
 * magnetic declination the WMM predicts for the map area today.
 *
 * Three independent "norths" meet here and must not be conflated:
 *
 * - **Georeference** — ScalePar (grid, offset, scale, grivation angle).
 *   This is a registration to the earth and does not change with time.
 *   Oxygen treats it as authoritative; it is never adjusted from
 *   magnetic physics. `MapFile.rotationCorrection` exists only as a
 *   manual ops override (`course.setMapRotation`) and defaults to 0.
 * - **Drawn meridian lines** — a compass aid laid down by the mapper for
 *   the declination on the production date. Declination drifts (Sweden:
 *   ≈ 0.1–0.2°/yr eastward), so the lines go stale. That staleness is
 *   what `computeMeridianStalenessDeg` reports:
 *
 *     staleness = declination(now) + trueNorthFromGrid − declaredGrivation − meridianTilt
 *
 *   i.e. today's grivation minus the grivation the lines were drawn at.
 *   Positive means the lines lag behind current magnetic north.
 * - **Display orientation** — what is "up" on screen and paper. The
 *   viewer and print pipeline put the meridian lines vertical by folding
 *   `meridianTiltDeg` into `northOffset` (`displayNorthOffsetDeg`).
 *   Pure presentation; it never moves anything geographically.
 *
 * History: an earlier version read the staleness formula as a
 * georeference error and auto-applied it as `rotationCorrection`, which
 * shifted GPS positions by ~200 m on Nackareservatet. See
 * `docs/bugfix-map-north-correction.md`.
 *
 * Club files often reuse 601.x for track symbols, so we cluster by exact
 * symbol id and require many near-parallel long lines.
 */

import proj4 from "proj4";
import geomagnetism from "geomagnetism";
// Importing map-projection also registers the Nordic EPSG defs proj4 needs.
import { getEpsgString, type OcadCrs } from "./map-projection.js";

/**
 * |staleness| at or above this is surfaced as a warning. WMM declination
 * uncertainty is ≈ 0.1–0.3° and the tilt measurement spread is ≈ 0.05°,
 * so 1° is well clear of noise (≈ 6 years of drift in Sweden).
 */
export const MERIDIAN_STALE_WARN_DEG = 1.0;

/** Minimum parallel lines in a 601.x cluster to count as meridians. */
export const MERIDIAN_MIN_COUNT = 10;

/** Max angle std-dev (degrees) for a near-parallel meridian cluster. */
export const MERIDIAN_MAX_STDDEV_DEG = 0.7;

export type MeridianProbe = {
  symbolId: number;
  count: number;
  /** Median tilt of lines from paper +Y, folded to [-90, 90]. */
  medianTiltDeg: number;
  stddevDeg: number;
};

/**
 * Persisted per map (`north_detection` JSONB). Everything except
 * `declinationDeg` / `meridianStalenessDeg` / `asOf` is static, so the
 * staleness can be re-evaluated for "today" from the stored row without
 * re-parsing the OCAD blob — see `meridianStalenessFromDetection`.
 */
export type NorthDetection = {
  declaredGrivationDeg: number;
  /** WMM declination at `asOf` (import time). */
  declinationDeg: number | null;
  /** atan2(de, dn) of a true-north step in grid coords (degrees). */
  trueNorthFromGridDeg: number | null;
  meridian: MeridianProbe | null;
  /** Drawn-meridian staleness at `asOf`; null without meridians or grid. */
  meridianStalenessDeg: number | null;
  centerLat: number | null;
  centerLng: number | null;
  asOf: string;
};

/**
 * Shape of `north_detection` rows written before the auto-apply removal.
 * Only the reset migration path needs these fields.
 */
export type LegacyNorthDetection = NorthDetection & {
  suggestedCorrectionDeg?: number | null;
  shouldAutoApply?: boolean;
  meridianGate?: boolean;
};

export type OcadNorthSource = {
  getCrs(): OcadCrs;
  objects?: Array<{
    sym?: number;
    objType?: number;
    coordinates?: number[][];
  }>;
};

/**
 * Angle (degrees) of the true-north direction measured from grid north,
 * in projected coordinates: atan2(Δeasting, Δnorthing) of a short true-north
 * step. Negative means true north is west of grid north.
 */
export function computeTrueNorthFromGrid(
  crs: OcadCrs,
  easting = crs.easting,
  northing = crs.northing,
): { angleDeg: number; lat: number; lng: number } | null {
  const epsg = getEpsgString(crs);
  if (!epsg) return null;
  try {
    const [lng, lat] = proj4(epsg, "EPSG:4326", [easting, northing]) as [
      number,
      number,
    ];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const [e2, n2] = proj4("EPSG:4326", epsg, [lng, lat + 0.001]) as [
      number,
      number,
    ];
    const angleDeg = (Math.atan2(e2 - easting, n2 - northing) * 180) / Math.PI;
    return { angleDeg, lat, lng };
  } catch {
    return null;
  }
}

/**
 * WMM magnetic declination (degrees, east positive) at a WGS84 point.
 * Returns null when the bundled coefficients do not cover `asOf` — the
 * `geomagnetism` package ships WMM epochs with a hard validity window
 * and throws outside it, which must never take a map upload down.
 */
export function computeDeclination(
  lat: number,
  lng: number,
  asOf: Date = new Date(),
): number | null {
  try {
    const model = geomagnetism.model(asOf);
    const decl = model.point([lat, lng]).decl;
    return Number.isFinite(decl) ? decl : null;
  } catch (err) {
    console.warn("[map-north] WMM declination unavailable:", err);
    return null;
  }
}

/**
 * Fold an oriented line angle into [-90, 90] so opposite directions of the
 * same undirected meridian coincide.
 */
export function foldLineAngleDeg(angleDeg: number): number {
  let a = angleDeg;
  while (a > 90) a -= 180;
  while (a < -90) a += 180;
  return a;
}

/**
 * Find the best magnetic-north-line cluster among exact 601xxx symbols.
 * Returns null when no cluster meets the count / parallelism thresholds.
 */
export function probeMeridianLines(
  objects: NonNullable<OcadNorthSource["objects"]>,
): MeridianProbe | null {
  const bySym = new Map<number, number[]>();
  for (const o of objects) {
    const sym = o.sym;
    if (sym == null) continue;
    const base = Math.floor(sym / 1000);
    if (base !== 601) continue;
    const c = o.coordinates;
    if (!c || c.length < 2) continue;
    const p0 = c[0];
    const p1 = c[c.length - 1];
    if (!p0 || !p1 || p0.length < 2 || p1.length < 2) continue;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy);
    // Drop tiny fragments (noise / decoration ticks).
    if (len < 500) continue; // 5 mm on paper (OCAD units = 0.01 mm)
    const ang = foldLineAngleDeg((Math.atan2(dx, dy) * 180) / Math.PI);
    const list = bySym.get(sym) ?? [];
    list.push(ang);
    bySym.set(sym, list);
  }

  let best: MeridianProbe | null = null;
  for (const [symbolId, angles] of bySym) {
    if (angles.length < MERIDIAN_MIN_COUNT) continue;
    const mean = angles.reduce((s, a) => s + a, 0) / angles.length;
    const variance =
      angles.reduce((s, a) => s + (a - mean) * (a - mean), 0) / angles.length;
    const stddevDeg = Math.sqrt(variance);
    if (stddevDeg > MERIDIAN_MAX_STDDEV_DEG) continue;
    const sorted = [...angles].sort((a, b) => a - b);
    const medianTiltDeg = sorted[Math.floor(sorted.length / 2)]!;
    const probe: MeridianProbe = {
      symbolId,
      count: angles.length,
      medianTiltDeg,
      stddevDeg,
    };
    if (!best || probe.count > best.count) best = probe;
  }
  return best;
}

/**
 * Round to 0.1° — enough for GPS overlay, stable across re-uploads.
 */
export function roundTenths(deg: number): number {
  return Math.round(deg * 10) / 10;
}

/**
 * How far the drawn magnetic-north lines lag behind the magnetic
 * declination at `declinationDeg`'s date (degrees, positive = lines point
 * west of current magnetic north, the usual case in Sweden).
 *
 *   staleness = declination + trueNorthFromGrid − declaredGrivation − meridianTilt
 *
 * `declination + trueNorthFromGrid` is today's magnetic bearing measured
 * from grid north; `declaredGrivation + meridianTilt` is the bearing the
 * mapper drew the lines at (paper rotation plus in-paper tilt). This is
 * a statement about the *lines*, not the georeference — a stale set of
 * meridians is normal on a map that is a few years old.
 */
export function computeMeridianStalenessDeg(opts: {
  declinationDeg: number;
  trueNorthFromGridDeg: number;
  declaredGrivationDeg: number;
  meridianTiltDeg: number;
}): number {
  return roundTenths(
    opts.declinationDeg +
      opts.trueNorthFromGridDeg -
      opts.declaredGrivationDeg -
      opts.meridianTiltDeg,
  );
}

/**
 * Re-evaluate meridian staleness for `asOf` (default: now) from a stored
 * detection row. Cheap — a WMM point evaluation — so list endpoints can
 * call it per map and a map that was fine at import starts to warn as
 * the years pass. Null when the map has no meridian cluster, no usable
 * grid, or the WMM cannot cover `asOf`.
 */
export function meridianStalenessFromDetection(
  detection: Pick<
    NorthDetection,
    | "meridian"
    | "declaredGrivationDeg"
    | "trueNorthFromGridDeg"
    | "centerLat"
    | "centerLng"
  > | null | undefined,
  asOf: Date = new Date(),
): number | null {
  if (!detection?.meridian) return null;
  const { trueNorthFromGridDeg, centerLat, centerLng } = detection;
  if (trueNorthFromGridDeg == null || centerLat == null || centerLng == null) {
    return null;
  }
  const declinationDeg = computeDeclination(centerLat, centerLng, asOf);
  if (declinationDeg == null) return null;
  return computeMeridianStalenessDeg({
    declinationDeg,
    trueNorthFromGridDeg,
    declaredGrivationDeg: detection.declaredGrivationDeg,
    meridianTiltDeg: detection.meridian.medianTiltDeg,
  });
}

/** True when the drawn north lines are worth flagging to the user. */
export function isMeridianStale(stalenessDeg: number | null | undefined): boolean {
  return stalenessDeg != null && Math.abs(stalenessDeg) >= MERIDIAN_STALE_WARN_DEG;
}

/**
 * Bearing from true north to the direction the viewer should put at the
 * top of the screen. Base is the paper +Y bearing
 * (`computeMapNorthOffset`); when the file has a meridian-line cluster,
 * fold its in-paper tilt in so the viewer's `-northOffset` rotation makes
 * the meridians vertical instead of the paper edges.
 */
export function displayNorthOffsetDeg(
  paperNorthOffsetDeg: number | null,
  meridian: MeridianProbe | null,
): number | null {
  if (paperNorthOffsetDeg == null) return null;
  return paperNorthOffsetDeg + (meridian?.medianTiltDeg ?? 0);
}

/**
 * Rotation to apply to automatic circle slits when drawing in screen
 * space. Cuts are authored in paper-mm compass bearings (0° = paper +Y);
 * the viewer rotates the whole map by `-northOffset` which already
 * folds in meridian tilt, so slits must use only the paper-to-true-north
 * part — otherwise a 3° meridian tilt biases every slit clockwise.
 *
 * `northOffset` is the stored display value (`displayNorthOffsetDeg`);
 * `meridianTiltDeg` is the in-paper tilt of ISOM 601.x lines (0 when the
 * file has none).
 */
export function cutRotationDeg(
  northOffset: number | null | undefined,
  meridianTiltDeg: number | null | undefined,
): number | null {
  if (northOffset == null || !Number.isFinite(northOffset)) return null;
  const tilt =
    meridianTiltDeg != null && Number.isFinite(meridianTiltDeg)
      ? meridianTiltDeg
      : 0;
  return northOffset - tilt;
}

/**
 * Analyse a parsed OCAD file's north situation. Pure diagnostics: the
 * result never changes how the map is georeferenced. `asOf` defaults to
 * now because the question the caller asks is "are the drawn north
 * lines stale *today*", not at the file's last-saved date.
 */
export function detectMapNorth(
  ocad: OcadNorthSource,
  asOf: Date = new Date(),
): NorthDetection {
  const crs = ocad.getCrs();
  const declaredGrivationDeg = (crs.grivation * 180) / Math.PI;
  const grid = computeTrueNorthFromGrid(crs);
  const meridian = probeMeridianLines(ocad.objects ?? []);

  const declinationDeg = grid
    ? computeDeclination(grid.lat, grid.lng, asOf)
    : null;
  const meridianStalenessDeg =
    grid && meridian && declinationDeg != null
      ? computeMeridianStalenessDeg({
          declinationDeg,
          trueNorthFromGridDeg: grid.angleDeg,
          declaredGrivationDeg,
          meridianTiltDeg: meridian.medianTiltDeg,
        })
      : null;

  return {
    declaredGrivationDeg,
    declinationDeg,
    trueNorthFromGridDeg: grid?.angleDeg ?? null,
    meridian,
    meridianStalenessDeg,
    centerLat: grid?.lat ?? null,
    centerLng: grid?.lng ?? null,
    asOf: asOf.toISOString(),
  };
}