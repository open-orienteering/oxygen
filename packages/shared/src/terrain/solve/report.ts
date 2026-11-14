/**
 * The terrain report and the components (docs/map-terrain.md §3.6).
 */

import type { ContourGraph } from "../graph/types.js";
import { indexConsistency, type IndexPair, type RepairCounts } from "./index-repair.js";
import type { Forest } from "./levels.js";
import { NO_LEVEL, SIGN_CLASSES, type EvidenceClass, type EvidenceSet, type TerrainComponent, type TerrainReport, type TerrainSolution } from "./types.js";

/** Components listed in the report. */
const REPORT_COMPONENTS = 8;

export interface ReportInput {
  evidence: EvidenceSet;
  externalSource: string | null;
  externalChains: number;
  evidenceConflicts: number;
  pairs: readonly IndexPair[];
  counts: RepairCounts;
}

const mod5 = (v: number) => ((v % 5) + 5) % 5;

export function terrainReport(g: ContourGraph, sol: Omit<TerrainSolution, "components" | "report">, f: Forest, x: ReportInput): { components: TerrainComponent[]; report: TerrainReport } {
  const NC = g.chains.length;
  const len = g.chains.map((c) => c.lengthMm);
  const total = len.reduce((a, b) => a + b, 0) || 1;
  let strict = 0, flagged = 0, undecided = 0, leakyUndecided = 0, leakySigned = 0, conflict = 0, multiStep = 0, multiStepChains = 0;
  const byClass: Record<string, number> = {};
  const add = (k: string, v: number) => {
    if (v > 0) byClass[k] = (byClass[k] ?? 0) + v / total;
  };
  const cfOf = (c: number) => (sol.conflict[c] > 0.5 ? 1 : Math.min(1, sol.conflict[c]));
  for (let c = 0; c < NC; c++) {
    const l = len[c];
    if (!sol.side[c]) {
      if (g.leaky[c]) {
        leakyUndecided += l;
        add("leaky", l);
      } else {
        undecided += l;
        add("none", l);
      }
      continue;
    }
    if (g.leaky[c]) leakySigned += l;
    const cf = cfOf(c);
    conflict += cf * l;
    add("conflict", cf * l);
    add(SIGN_CLASSES[sol.signClass[c]], (1 - cf) * l);
    if (sol.flagged[c]) flagged += l;
    else strict += l;
    if (sol.chainStep[c] > 1) {
      multiStep += l;
      multiStepChains++;
    }
  }

  // components over decided chains (tiers 1–4)
  const byComp = new Map<number, { regions: Set<number>; len: number; strict: number; conflict: number; flagged: number; idx: number; lo: number; hi: number; chains: number[] }>();
  for (let c = 0; c < NC; c++) {
    if (!sol.side[c] || !g.pairs[c].length) continue;
    const p = g.pairs[c][0];
    const k = f.regionComponent[p.left];
    let o = byComp.get(k);
    if (!o) byComp.set(k, (o = { regions: new Set(), len: 0, strict: 0, conflict: 0, flagged: 0, idx: 0, lo: Infinity, hi: -Infinity, chains: [] }));
    for (const q of g.pairs[c]) {
      o.regions.add(q.left);
      o.regions.add(q.right);
    }
    o.len += len[c];
    o.conflict += cfOf(c) * len[c];
    if (sol.flagged[c]) o.flagged += len[c];
    else o.strict += len[c];
    if (g.chains[c].index) o.idx += len[c];
    o.chains.push(c);
  }
  for (const o of byComp.values()) {
    for (const r of o.regions) {
      o.lo = Math.min(o.lo, f.regionLevel[r]);
      o.hi = Math.max(o.hi, f.regionLevel[r]);
    }
  }
  const compOf = (c: number) => (g.pairs[c].length ? f.regionComponent[g.pairs[c][0].left] : -1);
  const components: TerrainComponent[] = [...byComp.entries()]
    .sort((a, b) => b[1].len - a[1].len || a[0] - b[0])
    .map(([id, o]) => ({
      id,
      regions: o.regions.size,
      lengthMm: o.len,
      confidence: Math.max(0, (o.strict - o.conflict) / o.len),
      flaggedShare: o.flagged / o.len,
      minLevel: o.lo,
      maxLevel: o.hi,
      indexLengthMm: o.idx,
      indexConsistency: indexConsistency(g, f, x.pairs, (c) => compOf(c) === id).value,
    }));

  // T1's figure: index length of the largest component on its modal residue
  const main = components[0];
  let modalShare: number | null = null;
  if (main) {
    const h = [0, 0, 0, 0, 0];
    for (const c of byComp.get(main.id)!.chains) if (g.chains[c].index && sol.chainLevel[c] !== NO_LEVEL) h[mod5(sol.chainLevel[c])] += len[c];
    const t = h.reduce((a, b) => a + b, 0);
    modalShare = t ? Math.max(...h) / t : null;
  }
  const ic = indexConsistency(g, f, x.pairs);
  const disagreements = { tick: 0, cliff: 0, lake: 0 };
  for (let c = 0; c < NC; c++) {
    const b = sol.externalDisagrees[c];
    if (b & 1) disagreements.tick++;
    if (b & 2) disagreements.cliff++;
    if (b & 4) disagreements.lake++;
  }
  let externalLen = 0;
  if (x.externalSource) for (let c = 0; c < NC; c++) if (sol.signClass[c] === 1) externalLen += len[c];
  const evidenceCounts = {
    dem: x.externalChains,
    tick: x.evidence.tick.length,
    cliff: x.evidence.cliff.length,
    lake: x.evidence.lake.length,
    top: x.evidence.top.length,
    formTick: x.evidence.formTick.length,
  } satisfies Record<EvidenceClass, number>;
  let weakRegions = 0;
  for (let r = 1; r < sol.regionWeak.length; r++) weakRegions += sol.regionWeak[r];
  const report: TerrainReport = {
    chains: NC,
    lengthMm: total,
    share: {
      strict: strict / total,
      flagged: flagged / total,
      decided: (strict + flagged - conflict) / total,
      undecided: undecided / total,
      leakyUndecided: leakyUndecided / total,
      leakySigned: leakySigned / total,
      conflict: conflict / total,
      multiStep: multiStep / total,
    },
    byClass,
    evidence: { ...evidenceCounts, conflictingChains: x.evidenceConflicts },
    external: x.externalSource ? { source: x.externalSource, chains: x.externalChains, lengthShare: externalLen / total, disagreements } : null,
    levels: {
      components: components.length,
      largestComponentShare: main ? main.lengthMm / total : 0,
      levelsInLargest: main ? main.maxLevel - main.minLevel + 1 : 0,
      multiStepChains,
      weakRegions,
    },
    index: {
      lengthMm: g.chains.reduce((a, c) => a + (c.index ? c.lengthMm : 0), 0),
      pairs: x.pairs.length,
      consistency: ic.value,
      modalShare,
      ...x.counts,
    },
    components: components.slice(0, REPORT_COMPONENTS).map((c) => ({ lengthShare: c.lengthMm / total, confidence: c.confidence, levels: c.maxLevel - c.minLevel + 1, indexConsistency: c.indexConsistency })),
  };
  return { components, report };
}
