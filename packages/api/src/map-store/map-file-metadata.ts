/**
 * The `map_files` quick-access columns — `scale`, `bounds`,
 * `north_offset`, `calibration` — from a map document's header and its
 * stage-5 meridian tilt (docs/map-storage.md §6.4, docs/map-import.md
 * §3.8). One function for both writers until slice C retires the raster
 * path: the import job's pin (`writeDocumentMapFileColumns`) and the
 * raster upload (`event-map.ts` `metadataFromOcad`, over the same
 * normalised input), so the two never disagree.
 */

import { z } from "zod";
import { mapDocument, mapGeo, mapImport } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

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

/**
 * Pin-time write (docs/map-storage.md §6.4): for every `map_files` row of
 * the event carrying `sourceHash`, recompute the four columns from the
 * stored document's header summary and report. Returns the number of
 * rows written; 0 when the document has no projectable CRS or no
 * stage-5 report (documents imported before `ocad-5` / `omap-2`).
 */
export async function writeDocumentMapFileColumns(db: Db, eventId: bigint, sourceHash: string, documentHash: string): Promise<number> {
  const doc = await db.mapDocument.findUnique({ where: { hash: documentHash }, select: { header: true, report: true } });
  if (!doc) return 0;
  const frame = documentFrameSchema.safeParse(doc.header);
  const report = mapImport.importReportSchema.safeParse(doc.report);
  if (!frame.success || !report.success || !report.data.north) return 0;
  const tilt = report.data.north.meridian?.medianTiltDeg ?? null;
  const rows = await db.mapFile.findMany({ where: { eventId, sourceHash }, select: { id: true, rotationCorrection: true } });
  let written = 0;
  for (const row of rows) {
    const m = mapFileMetadataFor(frame.data, tilt, row.rotationCorrection);
    if (!m) continue;
    await db.mapFile.update({
      where: { id: row.id },
      data: {
        scale: m.scale,
        bounds: (m.bounds ?? undefined) as Prisma.InputJsonValue | undefined,
        northOffset: m.northOffset,
        calibration: (m.calibration ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
      },
    });
    written++;
  }
  return written;
}
