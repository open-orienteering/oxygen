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
import { buildHeightField, type HeightField, type HeightFieldOptions } from "./field/index.js";
import { buildContourGraph, type ContourGraphOptions } from "./graph/index.js";
import { solveTerrain, type SolveOptions, type TerrainReport } from "./solve/index.js";

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
