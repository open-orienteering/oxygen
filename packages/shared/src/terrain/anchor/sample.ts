/**
 * Chain statistics and the DEM side (docs/map-terrain.md §6.2–6.3).
 */

import { walkPolyline } from "../graph/flatten.js";
import { ANCHOR_RULES, type ChainDemStats, type DemSampler } from "./types.js";

/** Quantile of an ascending list, linear between order statistics; NaN when empty. */
export function quantile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const i = (n - 1) * p;
  const k = Math.floor(i);
  const hi = sorted[Math.min(n - 1, k + 1)];
  return sorted[k] + (hi - sorted[k]) * (i - k);
}

/** Side of the n × n box stencil for a smoothing length at a DEM cell, 1…5 (§6.3). */
export function stencilSize(demCellM: number, smoothM: number): number {
  if (smoothM <= 0 || !(demCellM > 0)) return 1;
  const n = 2 * Math.round((smoothM / demCellM - 1) / 2) + 1;
  return Math.max(1, Math.min(ANCHOR_RULES.maxStencil, n));
}

/** The box-mean model of §6.3 from point samples; the sampler itself when the stencil is 1. */
export function smoothedSampler(sample: DemSampler, demCellM: number, groundMPerMm: number, smoothM: number): DemSampler {
  const n = stencilSize(demCellM, smoothM);
  if (n === 1) return sample;
  const h = (n - 1) / 2;
  const step = demCellM / groundMPerMm;
  const count = n * n;
  return (x, y) => {
    let s = 0;
    for (let j = -h; j <= h; j++) {
      for (let i = -h; i <= h; i++) {
        const v = sample(x + i * step, y + j * step);
        if (Number.isNaN(v)) return NaN;
        s += v;
      }
    }
    return s / count;
  };
}

export interface SideRule {
  offsetM: number;
  minM: number;
}

/**
 * Samples a chain every 2 m on the ground: median, half-IQR and coverage
 * on `sample`; the side from `smooth` at ±offset along the normal (§6.2–6.3).
 */
export function chainDemStats(pts: Float64Array, closed: boolean, sample: DemSampler, smooth: DemSampler, groundMPerMm: number, rule: SideRule): ChainDemStats {
  const stepMm = ANCHOR_RULES.sampleStepM / groundMPerMm;
  const off = rule.offsetM / groundMPerMm;
  const hs: number[] = [];
  const ds: number[] = [];
  let samples = 0;
  walkPolyline(pts, closed, stepMm, (x, y, tx, ty) => {
    samples++;
    const h = sample(x, y);
    if (Number.isNaN(h)) return;
    hs.push(h);
    const hl = smooth(x - ty * off, y + tx * off);
    const hr = smooth(x + ty * off, y - tx * off);
    if (!Number.isNaN(hl) && !Number.isNaN(hr)) ds.push(hl - hr);
  });
  const coverage = samples ? hs.length / samples : 0;
  if (!hs.length) return { samples, valid: 0, coverage, median: NaN, halfIqr: NaN, sideMedian: NaN, sideAgree: 0, side: 0 };
  hs.sort((a, b) => a - b);
  ds.sort((a, b) => a - b);
  const median = quantile(hs, 0.5);
  const halfIqr = (quantile(hs, 0.75) - quantile(hs, 0.25)) / 2;
  const sideMedian = quantile(ds, 0.5);
  let pos = 0;
  for (const d of ds) if (d > 0) pos++;
  const posShare = ds.length ? pos / ds.length : 0;
  const sideAgree = ds.length ? (sideMedian > 0 ? posShare : 1 - posShare) : 0;
  const decided = coverage >= ANCHOR_RULES.coverageMin && Math.abs(sideMedian) >= rule.minM && sideAgree >= ANCHOR_RULES.sideAgreeMin;
  const side = decided ? (sideMedian > 0 ? 1 : -1) : 0;
  return { samples, valid: hs.length, coverage, median, halfIqr, sideMedian, sideAgree, side };
}
