/**
 * Geospatial PDF (docs/course-print.md §7.3; research 05 §5.9): the map
 * frame of a georeferenced document as a viewport whose `/Measure /GEO`
 * maps the frame's unit square to WGS 84 through its four corners. Four
 * points carry the window rotation, the meridian tilt and the small
 * non-orthogonality of lat / long with no special case.
 */

import { epsgOf, paperToWgs84, type PaperFrame } from "../geo/projection.js";
import { type ComposedPage, type GeoViewport, type MapLayerTransform, pagePointToMap } from "./page.js";

/** Unit-square corners of the bbox in the order the GPTS list them: lower-left, upper-left, upper-right, lower-right. */
const LPTS: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];

/**
 * The frame's viewport, or `null` when the document has no projectable
 * georeferencing (`epsgOf` null). Corners go page → `T_map⁻¹` → paper
 * native units → `paperToWgs84`.
 */
export function geoViewport(frameUm: ComposedPage["frameUm"], t: MapLayerTransform, frame: PaperFrame): GeoViewport | null {
  if (!epsgOf(frame)) return null;
  const { x, y, width, height } = frameUm;
  const gpts: [number, number][] = [];
  for (const [u, v] of LPTS) {
    const [mx, my] = pagePointToMap(t, x + u * width, y + v * height);
    const ll = paperToWgs84(frame, (mx / 1000) * frame.unitsPerMm, (my / 1000) * frame.unitsPerMm);
    if (!ll) return null;
    gpts.push([ll.lat, ll.lng]);
  }
  return { bboxUm: [x, y, x + width, y + height], gpts, lpts: LPTS.map(([u, v]) => [u, v]) };
}

/** WKT of the geographic CRS the GPTS are in (`/GCS /WKT`; EPSG 4326 alongside). */
export const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
