/**
 * A changed contour interval reaches the climbs (docs/course-elevation.md
 * §0.43, §6 "When"): every computed climb of every event on the map rested
 * on the old interval, so it is cleared (journaled) and computed again.
 * Typed and file climbs are untouched. A node that does not hold an
 * event's lease leaves it to the holder, whose map refresh picks the new
 * value up (§6 "During a lease").
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { mayRunBackgroundJob } from "../background-lease.js";
import { clearComputedClimbs } from "../course-geometry.js";
import { refreshComputedClimbs } from "../course-climb.js";

/** The events whose map is a version of the club map. */
export async function eventsOnClubMap(db: PrismaClient, clubMapId: string): Promise<bigint[]> {
  const rows = await db.mapFile.findMany({ where: { clubMapVersion: { clubMapId } }, select: { eventId: true }, distinct: ["eventId"] });
  return rows.map((r) => r.eventId);
}

/** Clears and computes again the computed climbs of the events. Returns how many events it ran for. */
export async function applyContourInterval(db: PrismaClient, eventIds: readonly bigint[]): Promise<number> {
  let ran = 0;
  for (const eventId of eventIds) {
    if (!(await mayRunBackgroundJob(db, eventId, "contour-interval"))) continue;
    await clearComputedClimbs(db, eventId, "all", { emit: true });
    await refreshComputedClimbs(db, eventId);
    ran++;
  }
  return ran;
}
