/**
 * Types of the terrain solve (docs/map-terrain.md §3).
 *
 * Sides: +1 means uphill is left of the chain's drawing direction, −1
 * right, 0 undecided. Levels are integer contour intervals.
 */

/** Direct evidence classes, strongest first (§3.1). `dem` is the external side (H9). */
export type EvidenceClass = "dem" | "tick" | "cliff" | "lake" | "top" | "formTick";

/** How a chain's side was decided. */
export type SignClass = EvidenceClass | "slope" | "index" | "closure" | "bandDrain" | "bandUpper" | "closedHill";

/** Index 0 is "none"; a chain's `signClass` indexes this list. */
export const SIGN_CLASSES = ["none", "dem", "tick", "cliff", "lake", "top", "formTick", "slope", "index", "closure", "bandDrain", "bandUpper", "closedHill"] as const;
export type SignClassOrNone = (typeof SIGN_CLASSES)[number];
export const CLASS = Object.fromEntries(SIGN_CLASSES.map((k, i) => [k, i])) as Record<SignClassOrNone, number>;

/** Classes whose decisions are flagged heuristics (answer 15: closure among them). */
export const FLAGGED_CLASSES: readonly SignClass[] = ["closure", "bandDrain", "bandUpper", "closedHill"];

export interface SideEvidence {
  chain: number;
  /** +1: uphill is left of the chain; −1: right. */
  side: 1 | -1;
  weight: number;
}

/** The classes read from the map (§3.1). */
export type EvidenceSet = Record<Exclude<EvidenceClass, "dem">, SideEvidence[]>;

/** A side per chain from outside the document (H9: the DEM). */
export interface ExternalSide {
  /** Shown in the report, e.g. "lantmateriet-1m". */
  source: string;
  /** Per chain: +1, −1, or 0 for no statement. Length = chain count. */
  side: Int8Array;
}

export interface SolveOptions {
  /** The map's evidence (default `gatherEvidence(graph)`); a subset for hold-out. */
  evidence?: EvidenceSet;
  /** The strongest class when present (answer 14, §3.0). */
  external?: ExternalSide;
  /** Run the flagged heuristics (default true). */
  heuristics?: boolean;
  /** Let index contours set steps, flip flagged groups and decide chains (default true). */
  indexRepair?: boolean;
}

/** Where a cliff link's step came from. */
export const CLIFF_STEP_SOURCE = { implied: 0, index: 1, assumed: 2 } as const;

export interface TerrainComponent {
  /** Root region. */
  id: number;
  regions: number;
  /** Length of the decided chains in it, mm. */
  lengthMm: number;
  /** (strict length − conflict length) / length, 0 … 1. */
  confidence: number;
  flaggedShare: number;
  minLevel: number;
  maxLevel: number;
  indexLengthMm: number;
  /** Neighbour index pairs on one residue (§3.6); null without pairs. */
  indexConsistency: number | null;
}

export interface TerrainReport {
  chains: number;
  lengthMm: number;
  /** Fractions of contour length. */
  share: {
    strict: number;
    flagged: number;
    /** strict + flagged, conflict length removed: the 3D gate reads this (§3.0). */
    decided: number;
    undecided: number;
    leakyUndecided: number;
    leakySigned: number;
    conflict: number;
    multiStep: number;
  };
  /** Fractions of contour length by the class that decided the chain (conflict length apart). */
  byClass: Record<string, number>;
  /** Evidence items per class, and chains with direct evidence both ways. */
  evidence: Record<EvidenceClass, number> & { conflictingChains: number };
  external: { source: string; chains: number; lengthShare: number; disagreements: { tick: number; cliff: number; lake: number } } | null;
  levels: { components: number; largestComponentShare: number; levelsInLargest: number; multiStepChains: number; weakRegions: number };
  index: {
    lengthMm: number;
    pairs: number;
    /** Neighbour pairs on one residue, by weight (§3.6). */
    consistency: number | null;
    /** T1's figure: index length of the largest component on its modal residue. */
    modalShare: number | null;
    stepsSet: number;
    flippedGroups: number;
    flippedLengthMm: number;
    confirmedGroups: number;
    decidedChains: number;
    unresolved: number;
  };
  /** Largest first, at most 8. */
  components: { lengthShare: number; confidence: number; levels: number; indexConsistency: number | null }[];
}

export interface TerrainSolution {
  /** Per chain: +1 / −1 / 0. */
  side: Int8Array;
  /** Per chain: index into SIGN_CLASSES. */
  signClass: Uint8Array;
  /** Per chain: 1 when the decision rests on a flagged heuristic (its own class or its root's). */
  flagged: Uint8Array;
  /** Per chain: the chain its side descends from (itself for direct evidence and heuristics); −1 undecided. */
  root: Int32Array;
  /** Per chain: 1 when index repair flipped it (§3.5). */
  corrected: Uint8Array;
  /** Per chain: the highest contour level it stands for; NO_LEVEL without pairs. */
  chainLevel: Int32Array;
  /** Per chain: levels between its sides (1; > 1 multi-step; 0 undecided or no pairs). */
  chainStep: Uint8Array;
  /** Per chain: share of its samples on pairs contradicting the levels. */
  conflict: Float32Array;
  /** Per chain: bits of the direct classes that disagree with the external side (tick 1, cliff 2, lake 4). */
  externalDisagrees: Uint8Array;
  /** Per region (index 0 unused): floor level, 0 the lowest region of its connected set. */
  regionLevel: Int32Array;
  /** Per region: component of decided chains and index-set cliff links (root region; 0 for region 0). */
  regionComponent: Int32Array;
  /** Per region: 1 when its level was reached only through a zero-step weak link. */
  regionWeak: Uint8Array;
  /** Per `graph.cliffLinks` entry: level(second) − level(first), and where it came from. */
  cliffStep: Int32Array;
  cliffStepSource: Uint8Array;
  components: TerrainComponent[];
  report: TerrainReport;
}

export const NO_LEVEL = -2147483648;
