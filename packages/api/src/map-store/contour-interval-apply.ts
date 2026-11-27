/**
 * A changed contour interval reaches the climbs (docs/course-elevation.md
 * §0.43, §6 "When"): every computed climb of every event on the map rested
 * on the old interval, so it is cleared (journaled) and computed again.
 * Typed and file climbs are untouched. A node that does not hold an
 * event's lease leaves it to the holder, whose map refresh picks the new
 * value up (§6 "During a lease").
 */

import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "../generated/prisma/client.js";
import { mayRunBackgroundJob } from "../background-lease.js";
import { canRemoveClubMap } from "../club-map-library.js";
import { clearComputedClimbs } from "../course-geometry.js";
import { outsideClimbMarks } from "../course-climb-pending.js";
import { refreshComputedClimbs } from "../course-climb.js";

/** The events whose map is a version of the club map, not removed ones (their climbs are nobody's to compute). */
export async function eventsOnClubMap(db: PrismaClient, clubMapId: string): Promise<bigint[]> {
  const rows = await db.mapFile.findMany({ where: { clubMapVersion: { clubMapId }, event: { removed: false } }, select: { eventId: true }, distinct: ["eventId"] });
  return rows.map((r) => r.eventId);
}

/** Clears and computes again the computed climbs of one event, when this node may. */
let runs = 0;
/** For tests: how many runs have started. */
export const _contourIntervalRuns = (): number => runs;

async function applyToEvent(db: PrismaClient, eventId: bigint): Promise<boolean> {
  runs++;
  if (!(await mayRunBackgroundJob(db, eventId, "contour-interval"))) return false;
  await clearComputedClimbs(db, eventId, "all", { emit: true });
  await refreshComputedClimbs(db, eventId);
  return true;
}

const running = new Map<bigint, { again: boolean; done: Promise<void> }>();

/**
 * After the interval is stored: the climbs of the events are cleared and computed again in the background, one
 * run at a time per event (a second request while one runs makes it run once more). The mutation does not wait
 * (§0.43, §6 "When"). Never throws.
 */
export function enqueueContourInterval(db: PrismaClient, eventIds: readonly bigint[]): void {
  for (const eventId of eventIds) {
    const state = running.get(eventId);
    if (state) { state.again = true; continue; }
    const entry = { again: false, done: Promise.resolve() };
    // Started outside the request's climb-marks scope: the run outlives the request.
    entry.done = outsideClimbMarks(async () => {
      do {
        entry.again = false;
        try {
          await applyToEvent(db, eventId);
        } catch (err) {
          console.warn(`[contour-interval] climbs of event ${eventId} not recomputed:`, err);
        }
      } while (entry.again);
      running.delete(eventId);
    });
    running.set(eventId, entry);
  }
}

/** Resolves when no run is pending (tests, shutdown). */
export async function awaitContourIntervalJobs(): Promise<void> {
  while (running.size > 0) await Promise.all([...running.values()].map((s) => s.done));
}

/**
 * A club map's interval follows every event on it and recomputes their climbs, so changing it takes what deleting
 * the map takes: its uploader or an admin (docs/course-elevation.md §0.43).
 */
export function requireMayChangeClubMapInterval(ctx: { authEnabled: boolean; user: { id: string; isAdmin: boolean } | null }, createdBy: string | null): void {
  if (!canRemoveClubMap({ authEnabled: ctx.authEnabled, user: ctx.user, createdBy })) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the uploader of the club map or an admin can change its contour interval; it applies to every event that uses the map" });
  }
}
