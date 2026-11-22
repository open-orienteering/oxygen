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
import { legGridCovering, routeFeaturesOfDocument, type BoxedRouteFeature } from "../leg.js";
import { attributeLeg, featuresCost, factorsOf } from "./attribute.js";
import { median, runnerPaces, type FitObservation } from "./fit.js";
import { splitTrack, type LegRejection, type SplitOptions } from "./legs.js";
import { projectRecord, type TrackRecord } from "./record.js";

export interface CalibrationMap {
  features: readonly BoxedRouteFeature[];
  heightAt: ((p: RoutePoint) => number | null) | null;
  frame: PaperFrame;
  /** The document's bounds, native units and paper mm. */
  bounds: PaperBounds;
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number };
  groundMPerMm: number;
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
  };
}

/** A leg kept for the finder check: where it ran from and to, never reported. */
export interface PairLegs { from: RoutePoint; to: RoutePoint; cover: { minX: number; minY: number; maxX: number; maxY: number }; observations: number[] }

export interface MapObservations {
  observations: FitObservation[];
  pairs: Map<string, PairLegs>;
  tracks: number;
  tracksUsed: number;
  courses: number;
  rejected: Partial<Record<LegRejection | "blocked" | "not-ok", number>>;
  /** Median ground metres between a control and the track's pass of it. */
  medianMissM: number;
  /** Share of the kept legs' metres stepped in an uncrossable cell. */
  blockedShare: number;
  outside: number;
  warnings: string[];
}

export const MAX_BLOCKED_SHARE = 0.25;

/**
 * `runnerBase` and `pairPrefix` keep runners and control pairs of
 * different records apart.
 */
export function observeRecord(map: CalibrationMap, record: TrackRecord, runnerBase: number, pairPrefix: string, options: Partial<SplitOptions> = {}): MapObservations {
  const projected = projectRecord(map.frame, map.bounds, record);
  const rejected: MapObservations["rejected"] = {};
  const bump = (k: keyof MapObservations["rejected"], n = 1) => { rejected[k] = (rejected[k] ?? 0) + n; };
  const miss: number[] = [];
  const raw: { runner: number; pair: string; from: RoutePoint; to: RoutePoint; points: RoutePoint[]; timeS: number }[] = [];
  let tracksUsed = 0;
  for (const [i, track] of projected.tracks.entries()) {
    if (!track.ok) { bump("not-ok"); continue; }
    const controls = projected.courses.get(track.courseId)!;
    const split = splitTrack(controls, track, { ...options, groundMPerMm: map.groundMPerMm, bounds: map.boundsMm });
    for (const [k, n] of Object.entries(split.rejected)) bump(k as LegRejection, n);
    miss.push(...split.missM);
    if (split.legs.length > 0) tracksUsed++;
    for (const leg of split.legs) {
      const key = (p: RoutePoint) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      raw.push({ runner: runnerBase + i, pair: `${pairPrefix}${key(leg.from)}>${key(leg.to)}`, from: { x: leg.from.x, y: leg.from.y }, to: { x: leg.to.x, y: leg.to.y }, points: leg.points, timeS: leg.timeS });
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
      const f = attributeLeg(grid, l.points);
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
    observations, pairs, tracks: projected.tracks.length, tracksUsed, courses: projected.courses.size, rejected,
    medianMissM: median(miss), blockedShare: totalM > 0 ? blockedM / totalM : 0, outside: projected.outside, warnings: projected.warnings,
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
