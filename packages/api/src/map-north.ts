/**
 * Auto-detect a north/grivation correction for OCAD maps whose meridian
 * (magnetic north) lines don't match the declared grivation — common for
 * Swedish club exports where ScalePar declares a=0.
 *
 * The meridian lines drawn in the file (ISOM 601.x) are ground truth:
 * they mark magnetic north, so with a correct georeference their true
 * bearing equals the magnetic declination at survey time. The lines are
 * often *tilted inside the paper drawing* (Nackareservatet: 3.3° from
 * paper +Y — the drawing was rotated to fit the sheet), so the correction
 * must subtract that tilt:
 *
 *   suggested = declination + trueNorthFromGrid − declaredGrivation − meridianTilt
 *
 * At Nacka (EPSG:3006) that is ≈ 7.8° + (−2.8°) − 0° − 3.3° ≈ +1.7°.
 * Without detected meridians the tilt term is 0 (assume magnetic-up
 * drawing) and the formula degrades to the pure physics estimate.
 * The earlier "~11°" note was an unverified eyeball estimate; the
 * earlier "+4.5°/5°" figure omitted the meridian tilt. Both are wrong.
 *
 * Note the correction only fixes the *georeference* (GPS overlays, geo
 * bounds). What makes the meridian lines look vertical on screen is the
 * display-north fold in `event-map.ts` (`metadataFromOcad`), which adds
 * the meridian tilt to `northOffset` so the viewer's `-northOffset`
 * rotation aligns screen-up with the meridians instead of paper +Y.
 *
 * Club files often reuse 601.x for track symbols, so we cluster by exact
 * symbol id and require many near-parallel long lines.
 */

import proj4 from "proj4";
import geomagnetism from "geomagnetism";
import type { OcadCrs } from "./map-projection.js";
// Register Nordic EPSG defs used by computeTrueNorthFromGrid.
import "./map-projection.js";

/** Minimum |suggested| (degrees) before we auto-apply on upload. */
export const NORTH_AUTO_APPLY_MIN_DEG = 1.5;

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

export type NorthDetection = {
  declaredGrivationDeg: number;
  declinationDeg: number | null;
  /** atan2(de, dn) of a true-north step in grid coords (degrees). */
  trueNorthFromGridDeg: number | null;
  meridian: MeridianProbe | null;
  suggestedCorrectionDeg: number | null;
  /** True when a meridian cluster was found (magnetic-north convention). */
  meridianGate: boolean;
  /** True when we recommend applying `suggestedCorrectionDeg` on upload. */
  shouldAutoApply: boolean;
  centerLat: number | null;
  centerLng: number | null;
  asOf: string;
};

export type OcadNorthSource = {
  getCrs(): OcadCrs;
  objects?: Array<{
    sym?: number;
    objType?: number;
    coordinates?: number[][];
  }>;
  header?: { fileDate?: Date | string | number };
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
  const epsg = epsgString(crs);
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

/** WMM magnetic declination (degrees, east positive) at a WGS84 point. */
export function computeDeclination(
  lat: number,
  lng: number,
  asOf: Date = new Date(),
): number {
  const model = geomagnetism.model(asOf);
  return model.point([lat, lng]).decl;
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
 * Suggested georeference correction (degrees, clockwise positive — same
 * sign convention as `withGrivationCorrection` / `MapFile.rotationCorrection`).
 *
 *   suggested = declination + trueNorthFromGrid − declaredGrivation − meridianTilt
 *
 * The meridian lines mark magnetic north on the ground, so a correct
 * georeference points them at the declination. When they are tilted
 * inside the paper drawing (`meridianTiltDeg` from `probeMeridianLines`),
 * the paper needs that much *less* rotation. Pass 0 / omit when no
 * meridian cluster was found (assumes a magnetic-north-up drawing).
 */
export function suggestCorrectionDeg(opts: {
  declinationDeg: number;
  trueNorthFromGridDeg: number;
  declaredGrivationDeg: number;
  meridianTiltDeg?: number;
}): number {
  return roundTenths(
    opts.declinationDeg +
      opts.trueNorthFromGridDeg -
      opts.declaredGrivationDeg -
      (opts.meridianTiltDeg ?? 0),
  );
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
 * Run full north detection against a parsed OCAD file.
 */
export function detectNorthCorrection(
  ocad: OcadNorthSource,
  asOf: Date = resolveAsOf(ocad),
): NorthDetection {
  const crs = ocad.getCrs();
  const declaredGrivationDeg = (crs.grivation * 180) / Math.PI;
  const grid = computeTrueNorthFromGrid(crs);
  const meridian = probeMeridianLines(ocad.objects ?? []);
  const meridianGate = meridian != null;

  let declinationDeg: number | null = null;
  let suggestedCorrectionDeg: number | null = null;
  if (grid) {
    declinationDeg = computeDeclination(grid.lat, grid.lng, asOf);
    suggestedCorrectionDeg = suggestCorrectionDeg({
      declinationDeg,
      trueNorthFromGridDeg: grid.angleDeg,
      declaredGrivationDeg,
      meridianTiltDeg: meridian?.medianTiltDeg,
    });
  }

  const shouldAutoApply =
    meridianGate &&
    suggestedCorrectionDeg != null &&
    Math.abs(suggestedCorrectionDeg) >= NORTH_AUTO_APPLY_MIN_DEG;

  return {
    declaredGrivationDeg,
    declinationDeg,
    trueNorthFromGridDeg: grid?.angleDeg ?? null,
    meridian,
    suggestedCorrectionDeg,
    meridianGate,
    shouldAutoApply,
    centerLat: grid?.lat ?? null,
    centerLng: grid?.lng ?? null,
    asOf: asOf.toISOString(),
  };
}

function resolveAsOf(ocad: OcadNorthSource): Date {
  const raw = ocad.header?.fileDate;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  if (typeof raw === "string" || typeof raw === "number") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function epsgString(crs: OcadCrs): string | null {
  const code = crs.code;
  if (!code) return null;
  const epsg = `EPSG:${code}`;
  try {
    proj4(epsg);
    return epsg;
  } catch {
    return null;
  }
}
