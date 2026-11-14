/**
 * `anchorLevels`: the DEM read along every chain (docs/map-terrain.md §6.2–6.7, §6.9).
 */

import type { ContourGraph } from "../graph/types.js";
import { concentration, mod } from "./interval.js";
import { ladderVote } from "./ladder.js";
import { chainDemStats, smoothedSampler } from "./sample.js";
import { ANCHOR_RULES, ANCHOR_STATUS, NO_LEVEL, type AnchorOptions, type AnchorReport, type ChainAnchors, type DemAnchor, type DemSampler, type LadderArea } from "./types.js";

/** Length-weighted quantile: the first value whose cumulative weight reaches p (NaN without weight). */
export function weightedQuantile(values: ArrayLike<number>, weights: ArrayLike<number>, p: number): number {
  const idx: number[] = [];
  let tot = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i]) && weights[i] > 0) {
      idx.push(i);
      tot += weights[i];
    }
  }
  if (tot <= 0) return NaN;
  idx.sort((a, b) => values[a] - values[b] || a - b);
  let acc = 0;
  for (const i of idx) {
    acc += weights[i];
    if (acc >= p * tot) return values[i];
  }
  return values[idx[idx.length - 1]];
}

function chainArrays(n: number): ChainAnchors {
  return {
    coverage: new Float64Array(n),
    median: new Float64Array(n).fill(NaN),
    halfIqr: new Float64Array(n).fill(NaN),
    sideMedian: new Float64Array(n).fill(NaN),
    sideAgree: new Float64Array(n),
    side: new Int8Array(n),
    status: new Uint8Array(n),
    height: new Float64Array(n).fill(NaN),
    ladder: new Int32Array(n).fill(-1),
    area: new Int32Array(n).fill(-1),
    phase: new Float64Array(n).fill(NaN),
    ladderLevel: new Int32Array(n).fill(NO_LEVEL),
    residual: new Float64Array(n).fill(NaN),
  };
}

/** The DEM along every chain of `graph`: statistics, side, acceptance, ladders and levels (§6). */
export function anchorLevels(graph: ContourGraph, sampleDem: DemSampler, opts: AnchorOptions): DemAnchor {
  const I = opts.intervalM;
  const g = graph.inputs.groundMPerMm;
  const rule = ANCHOR_RULES.side[opts.grade];
  const smooth = smoothedSampler(sampleDem, opts.demCellM, g, rule.smoothM);
  const n = graph.chains.length;
  const c = chainArrays(n);
  const len = new Float64Array(n);
  const covered = new Uint8Array(n);
  const contributor = new Uint8Array(n);
  const contribHalfIqr = ANCHOR_RULES.contributorHalfIqr[opts.grade] * I;

  // §6.2–6.4: statistics, side, acceptance.
  for (let i = 0; i < n; i++) {
    const ch = graph.chains[i];
    len[i] = ch.lengthMm;
    const s = chainDemStats(ch.pts, ch.closed, sampleDem, smooth, g, rule);
    c.coverage[i] = s.coverage;
    c.median[i] = s.median;
    c.halfIqr[i] = s.halfIqr;
    c.sideMedian[i] = s.sideMedian;
    c.sideAgree[i] = s.sideAgree;
    c.side[i] = s.side;
    if (s.coverage < ANCHOR_RULES.coverageMin) {
      c.status[i] = ANCHOR_STATUS.uncovered;
      continue;
    }
    covered[i] = 1;
    c.status[i] = s.halfIqr <= ANCHOR_RULES.acceptHalfIqr * I ? ANCHOR_STATUS.unsnapped : ANCHOR_STATUS.spreadFailed;
    if (s.halfIqr <= contribHalfIqr && ch.lengthMm * g >= ANCHOR_RULES.contributorMinM) contributor[i] = 1;
  }

  // §6.5: interval concentration.
  const cw = new Float64Array(n);
  let contributors = 0;
  for (let i = 0; i < n; i++) {
    if (contributor[i]) {
      cw[i] = len[i];
      contributors++;
    }
  }
  const atI = concentration(c.median, cw, I);
  const atHalf = concentration(c.median, cw, I / 2);
  const levelsAllowed = opts.grade === "anchor" || atI.r >= ANCHOR_RULES.promoteR;

  // §6.6–6.7: ladders, vote, local phase, areas, levels.
  const vote = ladderVote({ chains: graph.chains, groundMPerMm: g, intervalM: I, median: c.median, contributor });
  const ladders = vote.ladders.map((l, k) => {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) if (vote.member[i] === k) w[i] = len[i];
    return { phaseM: l.phaseM, lengthMm: l.lengthMm, rAtI: concentration(c.median, w, I).r };
  });
  for (let i = 0; i < n; i++) {
    c.ladder[i] = vote.label[i];
    c.area[i] = vote.area[i];
    c.phase[i] = vote.phase[i];
    const accepted = c.status[i] === ANCHOR_STATUS.unsnapped;
    if (!accepted) continue;
    if (!levelsAllowed) {
      c.status[i] = ANCHOR_STATUS.coarse;
    } else {
      c.height[i] = c.median[i];
    }
    if (vote.label[i] < 0) continue;
    const level = Math.round((c.median[i] - vote.phase[i]) / I);
    c.residual[i] = c.median[i] - vote.phase[i] - I * level;
    if (levelsAllowed && Math.abs(c.residual[i]) <= ANCHOR_RULES.residualMax * I) {
      c.status[i] = ANCHOR_STATUS.snapped;
      c.ladderLevel[i] = level;
    }
  }

  // §6.9: areas with their index residue, and the report.
  const areas: LadderArea[] = vote.areas.map((a) => ({ ladder: a.ladder, cells: a.cells, lengthMm: 0, indexResidue: null, indexOnResidue: null }));
  const residueLen = areas.map(() => new Float64Array(ANCHOR_RULES.indexEvery));
  let total = 0, coveredLen = 0, idxCovered = 0, idxSnapped = 0, idxInAreas = 0, idxModal = 0;
  const share = { sideDecided: 0, accepted: 0, snapped: 0, unsnapped: 0, spreadFailed: 0, uncovered: 0, unlabelled: 0 };
  for (let i = 0; i < n; i++) {
    const l = len[i];
    const st = c.status[i];
    total += l;
    if (covered[i]) coveredLen += l;
    if (c.side[i] !== 0) share.sideDecided += l;
    if (st === ANCHOR_STATUS.uncovered) share.uncovered += l;
    else if (st === ANCHOR_STATUS.spreadFailed) share.spreadFailed += l;
    else {
      share.accepted += l;
      if (st === ANCHOR_STATUS.snapped) share.snapped += l;
      else share.unsnapped += l;
      if (c.ladder[i] < 0) share.unlabelled += l;
    }
    if (c.area[i] >= 0) areas[c.area[i]].lengthMm += l;
    if (graph.chains[i].index && covered[i]) {
      idxCovered += l;
      if (st === ANCHOR_STATUS.snapped) {
        idxSnapped += l;
        if (c.area[i] >= 0) residueLen[c.area[i]][mod(c.ladderLevel[i], ANCHOR_RULES.indexEvery)] += l;
      }
    }
  }
  areas.forEach((a, k) => {
    const r = residueLen[k];
    let best = 0, sum = 0;
    for (let j = 0; j < r.length; j++) {
      sum += r[j];
      if (r[j] > r[best]) best = j;
    }
    if (sum > 0) {
      a.indexResidue = best;
      a.indexOnResidue = r[best] / sum;
      idxInAreas += sum;
      idxModal += r[best];
    }
  });
  const frac = (v: number, of: number) => (of > 0 ? v / of : 0);
  for (const k of Object.keys(share) as (keyof typeof share)[]) share[k] = frac(share[k], total);
  const coveredW = new Float64Array(n);
  for (let i = 0; i < n; i++) if (covered[i]) coveredW[i] = len[i];
  const contribLen = cw.reduce((a, b) => a + b, 0);

  const report: AnchorReport = {
    source: opts.source,
    grade: opts.grade,
    intervalM: I,
    levelsAllowed,
    intervalSuspect: atHalf.r >= ANCHOR_RULES.suspectR && vote.labelledContributorShare < ANCHOR_RULES.suspectLabelled,
    coverage: frac(coveredLen, total),
    interval: { contributors, rAtI: atI.r, rAtHalfI: atHalf.r, phaseM: atI.phase },
    ladders: ladders.map((l) => ({ phaseM: l.phaseM, lengthShare: frac(l.lengthMm * g, contribLen * g), rAtI: l.rAtI })),
    areas: areas.map((a) => ({ ladder: a.ladder, lengthShare: frac(a.lengthMm, total), indexResidue: a.indexResidue, indexOnResidue: a.indexOnResidue })),
    share,
    index: { lengthMm: idxCovered, snappedShare: frac(idxSnapped, idxCovered), onOneResiduePerArea: idxInAreas > 0 ? idxModal / idxInAreas : null },
    alongContour: { halfIqrP50: weightedQuantile(c.halfIqr, coveredW, 0.5), halfIqrP90: weightedQuantile(c.halfIqr, coveredW, 0.9) },
  };

  return {
    intervalM: I,
    source: opts.source,
    grade: opts.grade,
    levelsAllowed,
    chains: c,
    external: { source: opts.source, side: c.side },
    ladders,
    areas,
    report,
  };
}
