/**
 * What the vector base layer reads from a map document's header
 * (docs/map-rendering.md §5.4 "Layer"): the paper frame for `mapGeo`,
 * the drawn extent in paper mm, the colour of each stack position, the
 * proxy colours for unmatched symbols and the GPU budget.
 */

import { render, type mapDocument, type mapGeo } from "@oxygen/shared";
import { CLUB_BUDGET_BYTES, EVENT_BUDGET_BYTES } from "../map-gl/buckets";
import { hexToRgb } from "../map-gl/renderer";

/** The document's paper frame (native units) with the operator's rotation correction (`map_files.rotation_correction`). */
export function paperFrameOf(header: mapDocument.MapDocumentHeader, correctionDeg?: number | null): mapGeo.PaperFrame {
  return {
    unitsPerMm: header.unitsPerMm,
    mapScale: header.mapScale,
    georeferencing: header.georeferencing,
    correctionDeg: correctionDeg ?? 0,
  };
}

/** The header's object bounds in paper mm. */
export function boundsMm(header: mapDocument.MapDocumentHeader): { minX: number; minY: number; maxX: number; maxY: number } {
  const u = header.unitsPerMm, b = header.bounds;
  return { minX: b.minX / u, minY: b.minY / u, maxX: b.maxX / u, maxY: b.maxY / u };
}

/** Stack position → sRGB 0..1 from the document's CMYK; magenta for an index the stack does not have. */
export function documentColours(colours: render.ColourStack): (idx: number) => [number, number, number] {
  const rgb = colours.map((c) => hexToRgb(render.cmykToHex(c.cmyk)));
  return (i) => rgb[i] ?? [1, 0, 1];
}

/** Proxy colours for unmatched symbols: lines / points / text in the stack's darkest colour, areas in its lightest non-white one. */
export function documentProxyColours(colours: render.ColourStack): { line: number; area: number; point: number; text: number } {
  if (!colours.length) return { line: 0, area: 0, point: 0, text: 0 };
  const lum = (i: number) => {
    const [c, m, y, k] = colours[i].cmyk;
    return (1 - Math.min(1, k)) * (3 - Math.min(1, c) - Math.min(1, m) - Math.min(1, y));
  };
  let dark = 0, light = 0;
  for (let i = 1; i < colours.length; i++) {
    if (lum(i) < lum(dark)) dark = i;
    if (lum(i) > lum(light) && lum(i) < 2.9) light = i;
  }
  return { line: dark, area: light, point: dark, text: dark };
}

export type MapBudget = "event" | "club";

/** Resident GPU budget by provenance (docs/map-rendering.md §5.2 "Arena and buckets"). */
export function budgetBytes(budget: MapBudget): number {
  return budget === "club" ? CLUB_BUDGET_BYTES : EVENT_BUDGET_BYTES;
}
