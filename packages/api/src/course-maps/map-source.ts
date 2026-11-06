/**
 * The base map facts a print and a layout need: the scale and meridian
 * tilt of the event's pinned map document (docs/course-print.md §10).
 * The OCAD → SVG base map that used to live here went with the legacy
 * print page and the `window.png` route in E4a.
 */
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { documentFrame, documentNorth, eventDocumentHash } from "../map-store/event-document.js";

export interface BaseMapInfo {
  scale: number;
  meridianTiltDeg: number;
  version: string;
  /** The pinned map document every print draws from (docs/course-print.md §10). */
  document: { hash: string };
}

type MapInfoReader = PrismaClient | Prisma.TransactionClient;

/**
 * Scale and meridian tilt of the event's pinned document, for every event
 * (docs/course-print.md §10); `version` and `document` name the pinned
 * document. Throws "No base map uploaded" without a pin.
 */
export async function getBaseMapInfo(db: MapInfoReader, eventId: bigint): Promise<BaseMapInfo> {
  const hash = await eventDocumentHash(db, eventId);
  if (!hash) throw new Error("No base map uploaded");
  const stored = await documentFrame(db, hash);
  if (!stored) throw new Error("Pinned map document is missing");
  const scale = stored.frame.mapScale;
  if (!scale || scale <= 0) throw new Error("Base map has no usable scale");
  const meridianTiltDeg = (await documentNorth(db, hash))?.meridian?.medianTiltDeg ?? 0;
  return { scale, meridianTiltDeg, version: hash, document: { hash } };
}

/** Like `getBaseMapInfo`, but null when no base map is uploaded. */
export async function getBaseMapInfoOrNull(db: MapInfoReader, eventId: bigint): Promise<BaseMapInfo | null> {
  try {
    return await getBaseMapInfo(db, eventId);
  } catch {
    return null;
  }
}
