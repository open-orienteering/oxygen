/**
 * `solveTerrain`: one uphill side per chain and one level per region
 * (docs/map-terrain.md §3).
 */

import type { ContourGraph } from "../graph/types.js";
import { gatherEvidence } from "./evidence.js";
import { bandRule, closedHillRule, closureRule } from "./heuristics.js";
import { INDEX_RULES, indexNeighbours, repairCounts, repairPass, type RepairContext } from "./index-repair.js";
import { buildForest, type ForestInput } from "./levels.js";
import { cliffBornePairs, cliffLinkSides, leakyRegions } from "./probe.js";
import { terrainReport } from "./report.js";
import { applyEvidence, chainRegions, signState, slopeFix } from "./sign.js";
import type { EvidenceSet, SideEvidence, SolveOptions, TerrainSolution } from "./types.js";

/** Heuristic rounds at most (each decides at least one chain). */
const HEURISTIC_ROUNDS = 200;
/** Repair-and-closure rounds per settle. */
const SETTLE_ROUNDS = 60;

export function solveTerrain(g: ContourGraph, opts: SolveOptions = {}): TerrainSolution {
  const NC = g.chains.length;
  const evidence: EvidenceSet = opts.evidence ?? gatherEvidence(g);
  const s = signState(NC);
  const regionsOf = chainRegions(g);
  const links = cliffLinkSides(g);
  const input: ForestInput = { side: s.side, flagged: s.flagged, cliffBorne: cliffBornePairs(g), linkSamples: links.samples, overrides: new Map(), leakyRegion: leakyRegions(g) };
  const repair = opts.indexRepair !== false;
  const heuristics = opts.heuristics !== false;
  const ctx: RepairContext = {
    g,
    s,
    input,
    pairs: indexNeighbours(g, regionsOf),
    linkSecondAbove: links.secondAbove,
    counts: repairCounts(),
    groups: () => {
      const m = new Map<number, number[]>();
      for (let c = 0; c < NC; c++) {
        if (!s.side[c] || !s.flagged[c]) continue;
        const l = m.get(s.root[c]);
        if (l) l.push(c);
        else m.set(s.root[c], [c]);
      }
      return m;
    },
  };

  /** Between stages (T1's order): slope propagation, then index repair and closure until nothing changes. */
  const settle = (flips: boolean) => {
    slopeFix(g, s, regionsOf);
    for (let i = 0; i < SETTLE_ROUNDS; i++) {
      let n = repair ? repairPass(ctx, flips) : 0;
      if (heuristics) n += closureRule(g, s, buildForest(g, input));
      if (!n) break;
      slopeFix(g, s, regionsOf);
    }
  };

  // the external side first (answer 14), then the map's classes in the split's order
  const externalDisagrees = new Uint8Array(NC);
  let externalList: SideEvidence[] = [];
  if (opts.external) {
    const ext = opts.external.side;
    externalList = [...ext].flatMap((v, chain) => (v ? [{ chain, side: (v > 0 ? 1 : -1) as 1 | -1, weight: 1 }] : []));
    const bit = { tick: 1, cliff: 2, lake: 4 } as const;
    for (const k of ["tick", "cliff", "lake"] as const) for (const e of evidence[k]) if (ext[e.chain] && ext[e.chain] !== e.side) externalDisagrees[e.chain] |= bit[k];
    applyEvidence(s, [["dem", externalList]]);
    settle(false);
  }
  applyEvidence(s, [
    ["tick", evidence.tick],
    ["cliff", evidence.cliff],
    ["lake", evidence.lake],
    ["top", evidence.top],
  ]);
  settle(false);
  applyEvidence(s, [["formTick", evidence.formTick]]);
  settle(false);

  if (heuristics) {
    for (let it = 0; it < HEURISTIC_ROUNDS; it++) {
      let n = bandRule(g, s, "bandDrain");
      if (!n) n = bandRule(g, s, "bandUpper");
      if (!n) n = closedHillRule(g, s);
      if (!n) break;
      settle(false);
    }
  }
  if (repair) settle(true);

  const f = buildForest(g, input);
  const sol: Omit<TerrainSolution, "components" | "report"> = {
    side: s.side,
    signClass: s.cls,
    flagged: s.flagged,
    root: s.root,
    corrected: s.corrected,
    chainLevel: f.chainLevel,
    chainStep: f.chainStep,
    conflict: f.conflict,
    externalDisagrees,
    regionLevel: f.regionLevel,
    regionComponent: f.regionComponent,
    regionWeak: f.regionWeak,
    cliffStep: f.cliffStep,
    cliffStepSource: f.cliffStepSource,
  };
  const { components, report } = terrainReport(g, sol, f, {
    evidence,
    externalSource: opts.external?.source ?? null,
    externalChains: externalList.length,
    evidenceConflicts: s.evidenceConflicts,
    pairs: ctx.pairs,
    counts: ctx.counts,
  });
  return { ...sol, components, report };
}
