/**
 * The contour interval of an event's map (docs/course-elevation.md §0.43):
 * the one a person confirmed, or none. A map from the club library
 * follows the club map's value; any other map carries its own column on
 * `map_files`. A venue box has no club map row (its `club_map_version_id`
 * is nulled), so the exporter writes the resolved value into the file row
 * and the box reads that.
 */

import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { EventPin } from "./event-document.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface EventInterval {
  /** The confirmed interval in metres; null: not confirmed. */
  confirmedM: number | null;
  /** Whose value it is: the club map's (every event using it follows) or the event's own. */
  from: "club" | "event";
  /** The club map the value belongs to, when `from` is `club`. */
  clubMapId: string | null;
}

/** The effective confirmed interval of an event's pinned map. */
export async function eventContourInterval(db: Db, pin: Pick<EventPin, "clubMapVersionId" | "contourIntervalM">): Promise<EventInterval> {
  if (pin.clubMapVersionId) {
    const version = await db.clubMapVersion.findUnique({ where: { id: pin.clubMapVersionId }, select: { clubMap: { select: { id: true, contourIntervalM: true } } } });
    if (version) return { confirmedM: version.clubMap.contourIntervalM, from: "club", clubMapId: version.clubMap.id };
  }
  return { confirmedM: pin.contourIntervalM, from: "event", clubMapId: null };
}

export { validContourInterval } from "@oxygen/shared/src/terrain/profile/index.js";
