/**
 * Types of the contour band graph (docs/map-terrain.md §1–2).
 *
 * Everything is in paper millimetres, x right, y up. Polylines are flat
 * `[x0, y0, x1, y1, …]` arrays.
 */

export type TerrainClass = "contour" | "index" | "form" | "tick" | "formTick" | "cliff" | "water" | "other";

/** One flattened part of a contour, index contour or form line object (§1.4). */
export interface ContourPiece {
  pts: Float64Array;
  closed: boolean;
  /** From an index contour (102). */
  index: boolean;
  /** Object index in the document. */
  object: number;
}

/** A slope tick (101.b on a contour, 103.b on a form line). */
export interface SlopeTick {
  x: number;
  y: number;
  /** Object rotation, counter-clockwise, radians. */
  angleRad: number;
  object: number;
}

/** One part of a cliff line (§1.2). */
export interface CliffLine {
  pts: Float64Array;
  /** +1 tags left of the drawing direction, −1 right, 0 untagged. */
  tagSide: -1 | 0 | 1;
  object: number;
}

export interface WaterArea {
  /** Outer ring first, then holes; rings of three points or more. */
  rings: Float64Array[];
  object: number;
}

export interface InputCounts {
  contourObjects: number;
  indexObjects: number;
  formObjects: number;
  ticks: number;
  formTicks: number;
  cliffObjects: number;
  taggedCliffs: number;
  waterAreas: number;
}

export interface ContourInputs {
  /** Ground metres per paper millimetre (`mapScale / 1000`). */
  groundMPerMm: number;
  /** Contours and index contours, in document order. */
  contours: ContourPiece[];
  formLines: ContourPiece[];
  ticks: SlopeTick[];
  formTicks: SlopeTick[];
  cliffs: CliffLine[];
  water: WaterArea[];
  /** Every part of every classified object, for the mapped-area mask (§2.3). */
  extentParts: Float64Array[];
  counts: InputCounts;
}

export type EndClass = "frame" | "merge" | "cliff" | "extended" | "dangling";

export interface Chain {
  pts: Float64Array;
  closed: boolean;
  /** Polyline length plus bridged gaps. */
  lengthMm: number;
  /** Length contributed by index-contour pieces. */
  indexLengthMm: number;
  /** More than half the length is index contour. */
  index: boolean;
  /** Classes of the start and end; null for a closed chain. */
  ends: [EndClass, EndClass] | null;
  /** Document objects of the joined pieces, in walk order. */
  objects: number[];
}

/** A grid over paper space; cell (cx, cy) covers [x0 + cx·cellMm, …) and is stored at cy·width + cx. */
export interface Grid {
  cellMm: number;
  x0: number;
  y0: number;
  width: number;
  height: number;
}

/** Mapped-area mask (§2.3): 1 inside. */
export interface AreaMask extends Grid {
  cells: Uint8Array;
}

/** Raster labels (§2.4): regions are 1 … regionCount, chain i is `chain0 − i`. */
export const LABEL = { free: 0, outside: -1, cliff: -3, chain0: -10 } as const;

export interface RegionRaster extends Grid {
  labels: Int32Array;
  regionCount: number;
  /** Per region (index 0 unused): number of cells. */
  regionCells: Uint32Array;
  /** Per region (index 0 unused): 1 when it touches the outside or the raster edge. */
  regionTouchesOutside: Uint8Array;
}

/** Regions on the left and right of a chain, with the samples that saw them. */
export interface SidePair {
  left: number;
  right: number;
  samples: number;
}

export interface ContourGraphOptions {
  /** Smallest graph raster cell, mm (default 0.1). */
  cellMm?: number;
  /** Cell budget; the cell grows beyond `cellMm` to stay under it (default 60 M). */
  maxCells?: number;
  /** Gap bridging distance on the ground, metres (default 45). */
  bridgeGroundM?: number;
}

export interface ContourGraphStats {
  objects: InputCounts;
  contours: {
    chains: number;
    closed: number;
    lengthMm: number;
    indexChains: number;
    snapJoins: number;
    bridgedGaps: number;
    extendedEnds: number;
  };
  formLines: { chains: number; lengthMm: number };
  openEnds: Record<EndClass, number>;
  graph: {
    regions: number;
    /** Connected components of the region graph over chain incidence. */
    components: number;
    leakyChains: number;
    leakyLengthMm: number;
  };
  raster: { cellMm: number; width: number; height: number; cells: number };
}

export interface ContourGraph {
  inputs: ContourInputs;
  chains: Chain[];
  formChains: Chain[];
  mask: AreaMask;
  raster: RegionRaster;
  /** Per chain: its (left, right) region pairs; empty when leaky. */
  pairs: SidePair[][];
  /** Per chain: 1 when its band leaks around it (§2.6). */
  leaky: Uint8Array;
  /** Per region (index 0 unused): chain → side bits (1 = region left of the chain, 2 = right). */
  regionChains: Map<number, number>[];
  /** Pairs of different regions facing each other across a cliff, lower id first. */
  cliffLinks: [number, number][];
  stats: ContourGraphStats;
}
