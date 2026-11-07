/**
 * The `map_files` quick-access columns — `scale`, `bounds`,
 * `north_offset`, `calibration` — from a map document's header and its
 * stage-5 meridian tilt (docs/map-storage.md §6.4, docs/map-import.md
 * §3.8). The one function behind every writer: the import job's pin and a
 * rotation change (`event-document.ts` `documentMapFileColumns` /
 * `writePinnedMapFileColumns`), and the club list's extent. The upload's
 * own OCAD parse used it too until E5 removed that parse.
 */

import { z } from "zod";
import { mapDocument, mapGeo } from "@oxygen/shared";

/** The header fields the columns depend on (all present in `map_documents.header`). */
export const documentFrameSchema = z.object({
  unitsPerMm: z.number().int().positive(),
  mapScale: z.number().positive(),
  georeferencing: mapDocument.georeferencingSchema,
  bounds: mapDocument.boundsSchema,
});
export type DocumentFrame = z.input<typeof documentFrameSchema>;

/**
 * Columns for one map file row: the document's extent and georeference
 * with the row's `rotation_correction` added to the grid rotation, and
 * the drawn meridians' tilt folded into `northOffset`. Null when the
 * document has no CRS proj4 can project — the caller then leaves the
 * row's columns as they are.
 */
export function mapFileMetadataFor(
  frame: DocumentFrame,
  meridianTiltDeg: number | null | undefined,
  rotationCorrectionDeg: number,
): mapGeo.MapFileMetadata | null {
  const paper: mapGeo.PaperFrame = { unitsPerMm: frame.unitsPerMm, mapScale: frame.mapScale, georeferencing: frame.georeferencing, correctionDeg: rotationCorrectionDeg };
  if (!mapGeo.epsgOf(paper)) return null;
  return mapGeo.mapFileMetadata(paper, frame.bounds, meridianTiltDeg);
}
