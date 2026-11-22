/**
 * How well a fitted model predicts legs it has not seen
 * (docs/course-elevation.md §7.9.5): control pairs are held out a fifth
 * at a time, the model fitted on the rest, and each held-out leg's time
 * predicted from the runner's pace on that runner's other legs.
 */

import type { CostModelData, SlopeData } from "../cost-model.js";
import { factorsOf, featuresCost } from "./attribute.js";
import { _fitOnce, fitPlan, median, quantile, runnerPaces, type FitObservation, type FitOptions, FIT_DEFAULTS } from "./fit.js";

export interface PredictionError {
  /** Legs predicted. */
  legs: number;
  /** Median and 90th percentile of |predicted − actual| ÷ actual. */
  medianAbs: number;
  p90Abs: number;
  /** Median of (predicted − actual) ÷ actual. */
  bias: number;
}

const errorOf = (rel: number[]): PredictionError => ({
  legs: rel.length,
  medianAbs: median(rel.map(Math.abs)),
  p90Abs: quantile(rel.map(Math.abs), 0.9),
  bias: median(rel),
});

export const FOLDS = 5;

/** The fold of each control pair: by sorted order, so nothing is random and no pair is on both sides. */
export function foldsOf(obs: readonly FitObservation[], folds = FOLDS): Map<string, number> {
  const pairs = [...new Set(obs.map((o) => o.pair))].sort();
  return new Map(pairs.map((p, i) => [p, i % folds]));
}

function predict(train: readonly FitObservation[], test: readonly FitObservation[], factors: ArrayLike<number>, slope: SlopeData): number[] {
  const paces = runnerPaces(train, factors, slope);
  const rel: number[] = [];
  for (const o of test) {
    const pace = paces.get(o.runner);
    if (pace === undefined || !Number.isFinite(pace) || o.timeS <= 0) continue;
    rel.push((pace * featuresCost(o.f, factors, slope) - o.timeS) / o.timeS);
  }
  return rel;
}

export function crossValidate(obs: readonly FitObservation[], base: CostModelData, options: FitOptions = {}): { fitted: PredictionError; base: PredictionError } {
  const o = { ...FIT_DEFAULTS, ...options };
  const fold = foldsOf(obs);
  const fitted: number[] = [], plain: number[] = [];
  for (let k = 0; k < FOLDS; k++) {
    const train = obs.filter((x) => fold.get(x.pair) !== k), test = obs.filter((x) => fold.get(x.pair) === k);
    if (train.length === 0 || test.length === 0) continue;
    const { plan } = fitPlan(train, o);
    const fit = _fitOnce(train, base, plan, o.rounds);
    fitted.push(...predict(train, test, fit.factors, fit.slope));
    plain.push(...predict(train, test, factorsOf(base), base.slope));
  }
  return { fitted: errorOf(fitted), base: errorOf(plain) };
}
