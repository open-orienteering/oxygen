/**
 * The event map's paper frame: scale and georeference of the pinned map
 * document (docs/map-storage.md §4.6).
 *
 * Several code paths need it — converting control map-mm positions to
 * WGS84, computing course lengths from the map scale, the IOF / Purple
 * Pen export, `course.checks`. The frame comes from the document's
 * header summary (`map_documents.header`), cached per document hash in
 * `map-store/event-document.ts`, with the row's `rotation_correction` as
 * `correctionDeg`.
 */

import type { mapGeo } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { mapMmToWgs84 } from "./map-projection.js";
import { documentPaperFrame, eventPin } from "./map-store/event-document.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The frame of the event's pinned map document, or null when the event
 * has no map or the import has not pinned a document yet. A frame
 * without a projectable CRS still carries `mapScale`; conversions on it
 * answer null.
 */
export async function loadEventCrs(
  db: Db,
  eventId: bigint,
): Promise<mapGeo.PaperFrame | null> {
  const pin = await eventPin(db, eventId);
  if (!pin?.documentHash) return null;
  return documentPaperFrame(db, pin.documentHash, pin.rotationCorrection);
}

/**
 * Recompute stored WGS84 coordinates from authoritative map-mm positions.
 * This keeps list/map consumers that read lat/lng directly aligned with
 * the pinned document's frame (run on every pin and rotation change).
 */
export async function synchronizePositionedControlCoordinates(
  db: Db,
  eventId: bigint,
): Promise<number> {
  const crs = await loadEventCrs(db, eventId);
  if (!crs) return 0;
  const controls = await db.control.findMany({
    where: {
      eventId,
      removed: false,
      OR: [{ xpos: { not: 0 } }, { ypos: { not: 0 } }],
    },
    select: { id: true, xpos: true, ypos: true },
  });
  const updates = controls.flatMap((control) => {
    const position = mapMmToWgs84(control.xpos, control.ypos, crs);
    return position
      ? [
          db.control.update({
            where: { id: control.id },
            data: { lat: position.lat, lng: position.lng },
          }),
        ]
      : [];
  });
  await Promise.all(updates);
  return updates.length;
}
