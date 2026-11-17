/**
 * The terrain solve: uphill side and levels (docs/map-terrain.md §3).
 *
 * Import by subpath: `@oxygen/shared/src/terrain/solve/index.js`.
 */

export * from "./types.js";
export { EVIDENCE_RULES, chainArea, cliffEvidence, evidenceContext, formTickEvidence, gatherEvidence, lakeEvidence, tickDirection, tickEvidence, topEvidence, type EvidenceContext } from "./evidence.js";
export { LevelUnion, SUSPECT_TIER, TIER, buildForest, edgeKey, forestEdges, linkKey, type Forest, type ForestEdge, type ForestInput } from "./levels.js";
export { PROBE_RULES, cliffBornePairs, cliffLinkSides, leakyRegions, type CliffLinkSides } from "./probe.js";
export { applyEvidence, chainRegions, signState, slopeFix, type SignState } from "./sign.js";
export { bandRule, closedHillRule, closureRule } from "./heuristics.js";
export { INDEX_RULES, indexConsistency, indexNeighbours, repairCounts, repairPass, type IndexPair, type RepairContext, type RepairCounts } from "./index-repair.js";
export { solveTerrain } from "./solve.js";
