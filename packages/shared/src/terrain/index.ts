/**
 * Terrain from a map document (docs/map-terrain.md §5.5): the band graph
 * (§2), the solve (§3) and the height field (§4–5) in one call.
 *
 * Import by subpath: `@oxygen/shared/src/terrain/index.js`. The stages are
 * imported from their own subpaths (`terrain/graph/`, `terrain/solve/`,
 * `terrain/field/`).
 */

import type { MapDocument } from "../map-document/codec.js";
import type { MapDocumentHeader } from "../map-document/header.js";
import { anchoredHeights, anchorLevels, HEIGHT_SOURCE, type AnchoredHeights, type AnchorReport, type DemGrade, type DemSampler } from "./anchor/index.js";
import { buildHeightField, type HeightField, type HeightFieldOptions, type HeightFieldProvider } from "./field/index.js";
import { buildContourGraph, type ContourGraphOptions } from "./graph/index.js";
import { NO_LEVEL, solveTerrain, type SolveOptions, type TerrainReport } from "./solve/index.js";

export interface DeriveTerrainOptions {
  /** Contour interval, metres (default `contourIntervalM(header)`). */
  intervalM?: number;
  /** The graph raster (§2.4; defaults 0.1 mm, 60 M cells). */
  graph?: ContourGraphOptions;
  /** The solve (§3.7); H9's external side enters here. */
  solve?: SolveOptions;
  /** The field grid (§4.6; defaults 0.2 mm, 4 M cells, 4096 per side). The interval is `intervalM`. */
  field?: Omit<HeightFieldOptions, "intervalM">;
}

export interface DerivedTerrain {
  field: HeightField;
  report: TerrainReport;
}

/** The interval a document's contours are assumed to count (answer 8): 2.5 m on an ISSprOM map, else 5 m. */
export function contourIntervalM(header: Pick<MapDocumentHeader, "library">): number {
  return header.library?.id.startsWith("ISSprOM") ? 2.5 : 5;
}

/** §5.5: H1 → H2 → H3; null when the document has no contours. The field is built whatever the report says (the 3D gate is the viewer's). */
export function deriveTerrain(doc: MapDocument, opts: DeriveTerrainOptions = {}): DerivedTerrain | null {
  const graph = buildContourGraph(doc, opts.graph);
  if (!graph) return null;
  const solution = solveTerrain(graph, opts.solve);
  const field = buildHeightField(graph, solution, { ...opts.field, intervalM: opts.intervalM ?? contourIntervalM(doc.header) });
  return { field, report: solution.report };
}

/** A DEM for `deriveAnchoredTerrain` (§7.5): the paper sampler and what stands behind it. */
export interface AnchoredDem {
  sample: DemSampler;
  grade: DemGrade;
  /** Ground cell of the model behind `sample`, metres (§6.1). */
  demCellM: number;
  /** Provider and resolution, e.g. `lantmateriet-2m`: the anchor's source and the field's `contours.<id>` (§7.0 answer 3). */
  providerId: string;
  provider?: HeightFieldProvider;
}

export interface DerivedAnchoredTerrain extends DerivedTerrain {
  anchor: AnchorReport;
  heights: AnchoredHeights["report"];
  /** Accepted over covered contour length (§6.4): the misalignment gate's input (§7.0 answer 2); 0 without coverage. */
  acceptedOfCovered: number;
}

/**
 * §4.9 and §7.5: the contour field re-derived with a DEM — H1's graph,
 * `anchorLevels` (§6), the solve with the DEM's side as external evidence
 * (§3.2), `anchoredHeights` (§6.8), and the field from those heights,
 * `datum: "absolute"`, source `contours.<providerId>`. A chain the DEM
 * gave no height but §3 a level takes the median component offset plus
 * its level, without confidence; one with neither seeds nothing. Null
 * without contours, like `deriveTerrain`.
 */
export function deriveAnchoredTerrain(doc: MapDocument, dem: AnchoredDem, opts: DeriveTerrainOptions = {}): DerivedAnchoredTerrain | null {
  const graph = buildContourGraph(doc, opts.graph);
  if (!graph) return null;
  const intervalM = opts.intervalM ?? contourIntervalM(doc.header);
  const anchor = anchorLevels(graph, dem.sample, { intervalM, source: dem.providerId, grade: dem.grade, demCellM: dem.demCellM });
  const solution = solveTerrain(graph, { ...opts.solve, external: anchor.external });
  const heights = anchoredHeights(graph, anchor, solution);
  const n = graph.chains.length;
  const offsets = [...heights.componentOffset.values()].sort((a, b) => a - b);
  const mapOffset = offsets.length > 0 ? offsets[offsets.length >> 1] : NaN;
  const chainHeightsM = new Float64Array(n);
  const chainConfident = new Uint8Array(n);
  for (let ci = 0; ci < n; ci++) {
    const h = heights.height[ci], src = heights.source[ci];
    if (Number.isFinite(h)) {
      chainHeightsM[ci] = h;
      chainConfident[ci] = src === HEIGHT_SOURCE.dem || (src === HEIGHT_SOURCE.neighbours && heights.bounded[ci] === 0) ? 1 : 0;
    } else {
      const L = solution.chainLevel[ci];
      chainHeightsM[ci] = L !== NO_LEVEL && Number.isFinite(mapOffset) ? mapOffset + intervalM * L : NaN;
    }
  }
  const field = buildHeightField(graph, solution, {
    ...opts.field,
    intervalM,
    anchored: {
      chainHeightsM,
      // a coarse model's heights are offsets on §3's levels: the relative rule says how good the shape is
      chainConfident: dem.grade === "anchor" ? chainConfident : undefined,
      source: `contours.${dem.providerId}`,
      provider: dem.provider,
    },
  });
  const r = anchor.report;
  return { field, report: solution.report, anchor: r, heights: heights.report, acceptedOfCovered: r.coverage > 0 ? r.share.accepted / r.coverage : 0 };
}
