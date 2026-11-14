/**
 * Types of the DEM anchor (docs/map-terrain.md §6).
 *
 * Paper mm, x right, y up; heights in metres. Sides: +1 means uphill is
 * left of the chain's drawing direction, −1 right, 0 no statement (§3).
 */

/** DEM height in metres at a paper position (mm); NaN = no data (§6.1). */
export type DemSampler = (xMm: number, yMm: number) => number;

/** Anchor grade: Lantmäteriet's 1 m model, or a coarse model such as GLO-30 (§6.0 answer 1). */
export type DemGrade = "anchor" | "coarse";

export interface AnchorOptions {
  /** The assumed contour interval, metres (answer 8). Never changed (§6.0 answer 2). */
  intervalM: number;
  /** Shown in the report and as the external side's source, e.g. "lantmateriet-1m". */
  source: string;
  grade: DemGrade;
  /** Ground cell of the model behind the sampler, metres (the 5 m box stencil, §6.3). */
  demCellM: number;
}

/** The rules of §6, in metres or fractions of the interval I. */
export const ANCHOR_RULES = {
  /** Ground spacing of chain samples (§6.2). */
  sampleStepM: 2,
  /** Valid samples over all samples for a covered chain (§6.2). */
  coverageMin: 0.9,
  /** Side test per grade (§6.3). */
  side: {
    anchor: { offsetM: 8, smoothM: 5, minM: 0.4 },
    coarse: { offsetM: 20, smoothM: 0, minM: 0.5 },
  },
  /** Share of side differences with the median's sign (§6.3). */
  sideAgreeMin: 0.65,
  /** Largest box stencil (n × n) of the smoothed model (§6.3). */
  maxStencil: 5,
  /** Acceptance: half-IQR ≤ this · I (§6.4). */
  acceptHalfIqr: 0.3,
  /** Contributors to the interval and the ladders: half-IQR ≤ this · I, per grade (§6.5). */
  contributorHalfIqr: { anchor: 0.25, coarse: 0.5 },
  /** Contributors: ground length at least this (§6.5). */
  contributorMinM: 60,
  /** A coarse DEM gets levels from R(I) ≥ this (§6.0 answer 1). */
  promoteR: 0.6,
  /** intervalSuspect: R(I/2) ≥ this and less than `suspectLabelled` of contributor length labelled (§6.5). */
  suspectR: 0.6,
  suspectLabelled: 0.5,
  /** Candidate ladders (§6.6). */
  ladder: {
    bins: 100,
    sigma: 0.06,
    massWindow: 0.15,
    massMin: 0.04,
    separation: 0.2,
    maxLadders: 4,
    memberWithin: 0.2,
  },
  /** Evidence grid and vote (§6.6). */
  vote: {
    cellM: 100,
    minRadius: 1,
    maxRadius: 5,
    enoughM: 1500,
    minEvidenceM: 300,
    winShare: 0.6,
  },
  /** An area with less own-ladder evidence is dissolved (§6.7). */
  areaMinM: 1500,
  /** Snapping: |residual| ≤ this · I (§6.7). */
  residualMax: 0.3,
  /** Index contours: every fifth level (§6.9). */
  indexEvery: 5,
  /** anchoredHeights: breadth-first depth over bands (§6.8). */
  neighbourDepth: 3,
  /** Candidates spreading over more than this · I mark a chain bounded (§6.8). */
  boundedSpread: 0.5,
  /** Coarse drift bound: shift where the residual exceeds this · I (§6.8). */
  driftBound: 1.5,
} as const;

/** A chain's anchor status (§6.4, §6.7). */
export const ANCHOR_STATUS = { uncovered: 0, spreadFailed: 1, unsnapped: 2, snapped: 3, coarse: 4 } as const;
export type AnchorStatus = (typeof ANCHOR_STATUS)[keyof typeof ANCHOR_STATUS];

/** Where an anchored height came from (§6.8). */
export const HEIGHT_SOURCE = { none: 0, dem: 1, neighbours: 2, component: 3 } as const;

/** No level; the same value as §3's. */
export const NO_LEVEL = -2147483648;

/** Per-chain DEM statistics (§6.2–6.3). */
export interface ChainDemStats {
  /** Samples taken, valid heights among them. */
  samples: number;
  valid: number;
  coverage: number;
  /** NaN when no valid sample. */
  median: number;
  halfIqr: number;
  /** Median of left − right on the smoothed model; NaN when no counted sample. */
  sideMedian: number;
  /** Share of counted differences with the median's sign. */
  sideAgree: number;
  /** +1 uphill left, −1 right, 0 undecided. */
  side: -1 | 0 | 1;
}

/** Per chain, struct of arrays, one entry per `graph.chains` (§6.4, §6.7). */
export interface ChainAnchors {
  coverage: Float64Array;
  median: Float64Array;
  halfIqr: Float64Array;
  sideMedian: Float64Array;
  sideAgree: Float64Array;
  side: Int8Array;
  status: Uint8Array;
  /** The unsnapped DEM median of an accepted chain; NaN otherwise (and under an unpromoted coarse grade). */
  height: Float64Array;
  /** Winning ladder; −1 unlabelled. */
  ladder: Int32Array;
  /** Ladder area; −1 none. */
  area: Int32Array;
  /** Local phase, metres; NaN unlabelled. */
  phase: Float64Array;
  /** Absolute integer level; NO_LEVEL unless snapped. */
  ladderLevel: Int32Array;
  /** median − phase − I · level; NaN unlabelled. */
  residual: Float64Array;
}

/** §3's ExternalSide, structurally. */
export interface ExternalSideOut {
  source: string;
  side: Int8Array;
}

export interface Ladder {
  /** Phase in [0, I), metres. */
  phaseM: number;
  /** Member length, mm. */
  lengthMm: number;
  /** R(I) over its members. */
  rAtI: number;
}

export interface LadderArea {
  ladder: number;
  /** Cells in the area. */
  cells: number;
  /** Length of the chains whose area this is, mm. */
  lengthMm: number;
  /** Modal residue of the snapped index chains' levels mod 5; null without any. */
  indexResidue: number | null;
  indexOnResidue: number | null;
}

export interface AnchorReport {
  source: string;
  grade: DemGrade;
  intervalM: number;
  levelsAllowed: boolean;
  intervalSuspect: boolean;
  coverage: number;
  interval: { contributors: number; rAtI: number; rAtHalfI: number; phaseM: number };
  ladders: { phaseM: number; lengthShare: number; rAtI: number }[];
  areas: { ladder: number; lengthShare: number; indexResidue: number | null; indexOnResidue: number | null }[];
  share: { sideDecided: number; accepted: number; snapped: number; unsnapped: number; spreadFailed: number; uncovered: number; unlabelled: number };
  index: { lengthMm: number; snappedShare: number; onOneResiduePerArea: number | null };
  alongContour: { halfIqrP50: number; halfIqrP90: number };
}

export interface DemAnchor {
  intervalM: number;
  source: string;
  grade: DemGrade;
  /** Anchor grade, or coarse promoted (§6.0 answer 1). */
  levelsAllowed: boolean;
  chains: ChainAnchors;
  external: ExternalSideOut;
  ladders: Ladder[];
  areas: LadderArea[];
  report: AnchorReport;
}

/** The fields of §3's TerrainSolution that §6.8 reads. */
export interface SolvedLevels {
  side: Int8Array;
  chainLevel: Int32Array;
  chainStep: Uint8Array;
  regionComponent: Int32Array;
}

export interface AnchoredHeights {
  /** Metres; NaN = none. */
  height: Float64Array;
  /** HEIGHT_SOURCE per chain. */
  source: Uint8Array;
  bounded: Uint8Array;
  /** Component root region → offset, metres. */
  componentOffset: Map<number, number>;
  /** Built from an unpromoted coarse DEM (a 30 m surface model). */
  coarse: boolean;
  report: {
    share: { dem: number; neighbours: number; component: number; none: number };
    /** Length share of bounded chains. */
    bounded: number;
    driftShifted: number;
    /** Length share of accepted chains by round((h − offset − I·L) / I). */
    drift: Record<string, number>;
  };
}
