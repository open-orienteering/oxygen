/**
 * Leg observations of a map's track records (docs/course-elevation.md
 * §7.9.2–7.9.3): every track cut into legs, each leg read on the grid
 * of its control pair.
 */

import type { PaperBounds, PaperFrame } from "../../geo/projection.js";
import type { MapDocument } from "../../map-document/index.js";
import { costModelFromData, type CostModelData } from "../cost-model.js";
import { findRoutes } from "../alternatives.js";
import type { RoutePoint } from "../grid.js";
import { legGridCovering, legWindow, routeFeaturesOfDocument, type BoxedRouteFeature } from "../leg.js";
import { SNAP_DEFAULTS, attributeLeg, featuresCost, factorsOf } from "./attribute.js";
import { median, runnerPaces, type FitObservation } from "./fit.js";
import { splitTrack, type LegRejection, type SplitOptions } from "./legs.js";
import { projectRecord, type TrackRecord, type TrackWarning } from "./record.js";

export interface CalibrationMap {
  features: readonly BoxedRouteFeature[];
  heightAt: ((p: RoutePoint) => number | null) | null;
  frame: PaperFrame;
  /** The document's bounds, native units and paper mm. */
  bounds: PaperBounds;
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number };
  groundMPerMm: number;
  /** Ground metres a track is put on a way from (§7.9.3); 0 on a sprint map, where ways are areas. */
  snapM: number;
}

export function calibrationMapOf(doc: MapDocument, heightAt: ((p: RoutePoint) => number | null) | null): CalibrationMap {
  const h = doc.header;
  const u = h.unitsPerMm;
  return {
    features: routeFeaturesOfDocument(doc as Parameters<typeof routeFeaturesOfDocument>[0]),
    heightAt,
    frame: { unitsPerMm: u, mapScale: h.mapScale, georeferencing: h.georeferencing },
    bounds: h.bounds,
    boundsMm: { minX: h.bounds.minX / u, minY: h.bounds.minY / u, maxX: h.bounds.maxX / u, maxY: h.bounds.maxY / u },
    groundMPerMm: h.mapScale / 1000,
    snapM: h.library?.id.startsWith("ISSprOM") ? 0 : SNAP_DEFAULTS.snapM,
  };
}

/** A leg kept for the finder check: where it ran from and to, never reported. */
export interface PairLegs { from: RoutePoint; to: RoutePoint; cover: { minX: number; minY: number; maxX: number; maxY: number }; observations: number[] }

export interface MapObservations {
  observations: FitObservation[];
  pairs: Map<string, PairLegs>;
  tracks: number;
  /** Tracks with a leg among the observations. */
  tracksUsed: number;
  courses: number;
  rejected: Partial<Record<Rejection, number>>;
  /** Median ground metres between a control and the track's pass of it. */
  medianMissM: number;
  /** Share of the kept legs' metres stepped in an uncrossable cell. */
  blockedShare: number;
  outside: number;
  warnings: TrackWarning[];
}

export const MAX_BLOCKED_SHARE = 0.25;

/** Why a leg (or, for `not-ok`, a track) is left out. */
export const REJECTIONS = ["control-missed", "gap", "jitter", "off-map", "standing", "too-short", "wandered", "blocked", "not-ok"] as const satisfies readonly (LegRejection | "wandered" | "blocked" | "not-ok")[];
export type Rejection = (typeof REJECTIONS)[number];

/** One record's legs: `observeRecords` of it alone. */
export function observeRecord(map: CalibrationMap, record: TrackRecord, runnerBase: number, pairPrefix: string, options: Partial<SplitOptions> = {}): MapObservations {
  return observeRecords(map, [record], runnerBase, pairPrefix, options);
}

/**
 * The legs of all of a map's records together: a control pair run in
 * several records (classes sharing a leg) is one pair, read on one
 * grid. `runnerBase` and `pairPrefix` keep runners and control pairs of
 * different maps apart.
 */
export function observeRecords(map: CalibrationMap, records: readonly TrackRecord[], runnerBase: number, pairPrefix: string, options: Partial<SplitOptions> = {}): MapObservations {
  const rejected: MapObservations["rejected"] = {};
  const bump = (k: Rejection, n = 1) => { rejected[k] = (rejected[k] ?? 0) + n; };
  const miss: number[] = [];
  const raw: { runner: number; pair: string; from: RoutePoint; to: RoutePoint; points: RoutePoint[]; timeS: number }[] = [];
  const warnings = new Set<TrackWarning>();
  let tracks = 0, courses = 0, outside = 0;
  for (const record of records) {
    const projected = projectRecord(map.frame, map.bounds, record);
    courses += projected.courses.size;
    outside += projected.outside;
    for (const w of projected.warnings) warnings.add(w);
    for (const track of projected.tracks) {
      const runner = runnerBase + tracks++;
      if (!track.ok) { bump("not-ok"); continue; }
      const controls = projected.courses.get(track.courseId)!;
      const split = splitTrack(controls, track, { ...options, groundMPerMm: map.groundMPerMm, bounds: map.boundsMm });
      for (const [k, n] of Object.entries(split.rejected)) bump(k as LegRejection, n);
      miss.push(...split.missM);
      for (const leg of split.legs) {
        const from = { x: leg.from.x, y: leg.from.y }, to = { x: leg.to.x, y: leg.to.y };
        // A track far outside the leg's window grown once more by its pad is not a route of this leg:
        // it would also make the leg's grid as large as the runner's detour.
        const w = legWindow({ from, to }).bounds;
        const pad = Math.min(from.x, to.x) - w.minX;
        if (leg.points.some((p) => p.x < w.minX - pad || p.x > w.maxX + pad || p.y < w.minY - pad || p.y > w.maxY + pad)) { bump("wandered"); continue; }
        const key = (p: RoutePoint) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
        raw.push({ runner, pair: `${pairPrefix}${key(from)}>${key(to)}`, from, to, points: leg.points, timeS: leg.timeS });
      }
    }
  }
  const byPair = new Map<string, typeof raw>();
  for (const r of raw) (byPair.get(r.pair) ?? byPair.set(r.pair, []).get(r.pair)!).push(r);
  const observations: FitObservation[] = [];
  const pairs = new Map<string, PairLegs>();
  let blockedM = 0, totalM = 0;
  for (const [pair, legs] of byPair) {
    const cover = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const l of legs) {
      for (const p of l.points) {
        cover.minX = Math.min(cover.minX, p.x); cover.maxX = Math.max(cover.maxX, p.x);
        cover.minY = Math.min(cover.minY, p.y); cover.maxY = Math.max(cover.maxY, p.y);
      }
    }
    const grid = legGridCovering(map.features, map.heightAt, { from: legs[0].from, to: legs[0].to, groundMPerMm: map.groundMPerMm }, cover);
    const kept: number[] = [];
    for (const l of legs) {
      const f = attributeLeg(grid, l.points, { snapM: map.snapM });
      if (f.totalM <= 0) { bump("too-short"); continue; }
      if (f.blockedM / f.totalM > MAX_BLOCKED_SHARE) { bump("blocked"); continue; }
      blockedM += f.blockedM;
      totalM += f.totalM;
      kept.push(observations.length);
      observations.push({ runner: l.runner, pair, timeS: l.timeS, f });
    }
    if (kept.length > 0) pairs.set(pair, { from: legs[0].from, to: legs[0].to, cover, observations: kept });
  }
  return {
    observations, pairs, tracks, tracksUsed: new Set(observations.map((x) => x.runner)).size, courses, rejected,
    medianMissM: median(miss), blockedShare: totalM > 0 ? blockedM / totalM : 0, outside, warnings: [...warnings].sort(),
  };
}

/**
 * Against the finder (§7.9.5): each leg's actual time over the time the
 * model's fastest route would take that runner. Near 1: the best
 * runners run about what the finder finds; under 1: they found
 * something faster than it did.
 */
export function finderRatios(map: CalibrationMap, set: Pick<MapObservations, "observations" | "pairs">, model: CostModelData, maxPairs = 400): number[] {
  const factors = factorsOf(model);
  const paces = runnerPaces(set.observations, factors, model.slope);
  const cm = costModelFromData(model);
  const ratios: number[] = [];
  const keys = [...set.pairs.keys()].sort();
  const stride = Math.max(1, Math.ceil(keys.length / maxPairs));
  for (let i = 0; i < keys.length; i += stride) {
    const pair = set.pairs.get(keys[i])!;
    const grid = legGridCovering(map.features, map.heightAt, { from: pair.from, to: pair.to, groundMPerMm: map.groundMPerMm });
    const fastest = findRoutes(grid, pair.from, pair.to, { model: cm, alternatives: 0 }).find((r) => r.fastest);
    if (!fastest || !Number.isFinite(fastest.costM) || fastest.costM <= 0) continue;
    for (const k of pair.observations) {
      const o = set.observations[k];
      const pace = paces.get(o.runner);
      if (pace !== undefined && Number.isFinite(pace)) ratios.push(o.timeS / (pace * fastest.costM));
    }
  }
  return ratios;
}

export { featuresCost };
