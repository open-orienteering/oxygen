/**
 * The contour band graph of a map document (docs/map-terrain.md §1–2).
 *
 * Import by subpath: `@oxygen/shared/src/terrain/graph/index.js`.
 */

import type { MapDocument } from "../../map-document/codec.js";
import { joinChains, snapJoin } from "./chains.js";
import { chainIncidence, cliffLinks, regionComponents } from "./incidence.js";
import { contourInputs } from "./inputs.js";
import { mappedAreaMask, polylinesBox } from "./mask.js";
import { labelRegions, rasteriseBarriers } from "./raster.js";
import type { ContourGraph, ContourGraphOptions, EndClass } from "./types.js";

export * from "./types.js";
export { canonicalCode, classifyTerrainSymbol, cliffTagSide, contourInputs } from "./inputs.js";
export { flattenObject, polylineEnd, polylineLength, walkPolyline, type PolylineEnd } from "./flatten.js";
export { CHAIN_RULES, bridges, classifyEnds, continues, joinChains, joinEnds, snapJoin, type JoinContext, type JoinResult } from "./chains.js";
export { MASK_CELL_MM, MASK_CLOSE_MM, chamferDistance, mappedAreaMask, maskAt, polylinesBox, type Box } from "./mask.js";
export { RASTER_RULES, cellIndex, labelRegions, rasteriseBarriers, type RasterOptions } from "./raster.js";
export { chainIncidence, cliffLinks, regionComponents, type Incidence } from "./incidence.js";
export { SegmentIndex, type NearestSegment } from "./seg-index.js";

/** §1 and §2.1–2.6 in order; null when the document has no contour pieces. */
export function buildContourGraph(doc: MapDocument, opts: ContourGraphOptions = {}): ContourGraph | null {
  const inputs = contourInputs(doc);
  const box = polylinesBox(inputs.contours.map((p) => p.pts));
  if (!box) return null;
  const mask = mappedAreaMask(inputs.extentParts, box);
  const joined = joinChains(inputs.contours, { cliffs: inputs.cliffs, mask, groundMPerMm: inputs.groundMPerMm, bridgeGroundM: opts.bridgeGroundM });
  const formChains = snapJoin(inputs.formLines).chains;
  const chains = joined.chains;
  const raster = rasteriseBarriers(chains, inputs.cliffs, mask, box, opts);
  labelRegions(raster);
  const { pairs, leaky, regionChains } = chainIncidence(chains, raster);
  const links = cliffLinks(inputs.cliffs, raster);

  const openEnds: Record<EndClass, number> = { frame: 0, merge: 0, cliff: 0, extended: 0, dangling: 0 };
  for (const c of chains) if (c.ends) for (const e of c.ends) openEnds[e]++;
  let leakyChains = 0, leakyLengthMm = 0;
  chains.forEach((c, i) => {
    if (leaky[i]) {
      leakyChains++;
      leakyLengthMm += c.lengthMm;
    }
  });
  return {
    inputs,
    chains,
    formChains,
    mask,
    raster,
    pairs,
    leaky,
    regionChains,
    cliffLinks: links,
    stats: {
      objects: { ...inputs.counts },
      contours: {
        chains: chains.length,
        closed: chains.filter((c) => c.closed).length,
        lengthMm: chains.reduce((a, c) => a + c.lengthMm, 0),
        indexChains: chains.filter((c) => c.index).length,
        snapJoins: joined.snapJoins,
        bridgedGaps: joined.bridgedGaps,
        extendedEnds: openEnds.extended,
      },
      formLines: { chains: formChains.length, lengthMm: formChains.reduce((a, c) => a + c.lengthMm, 0) },
      openEnds,
      graph: { regions: raster.regionCount, components: regionComponents(pairs, regionChains), leakyChains, leakyLengthMm },
      raster: { cellMm: raster.cellMm, width: raster.width, height: raster.height, cells: raster.width * raster.height },
    },
  };
}
