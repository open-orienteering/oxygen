/**
 * The course's stored climb (docs/course-elevation.md §6): the climb
 * computed from the pinned document's stored height field along the
 * course's drawn legs, written to `courses.climb_m` with
 * `climb_source = 'computed'` for ordered courses that have no typed or
 * imported climb.
 *
 * `rebuildCourseLengths` clears a computed climb inside the edit's
 * transaction; `refreshComputedClimbs` writes it again **after** that
 * transaction commits. The field is read as stored and never derived
 * here, and nothing of this runs inside an edit's transaction.
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { decodeHeightField, type HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { TERRAIN_VERSION } from "@oxygen/shared/src/terrain/field/index.js";
import { courseProfile, fieldSampler, pickClimbField, type ClimbFieldPick, type PaperPoint, type TerrainSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import type { ClimbMarks } from "./course-climb-pending.js";
import { loadCourseSequences } from "./course-geometry.js";
import { chosenLegRoutes, chosenRoutesStamp, climbLegsOf } from "./leg-routes.js";
import { emitCourseUpserted } from "./referenceJournal.js";
import { mayRunBackgroundJob } from "./background-lease.js";
import { eventPin } from "./map-store/event-document.js";
import { eventContourInterval } from "./map-store/contour-interval.js";
import { HEIGHTFIELD_SOURCE, readHeightfield, terrainDescriptor } from "./map-store/heightfield.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** A typed or imported climb: a compute never replaces it (§6 "Read rule"). */
export const isTypedClimb = (c: { climbM: number; climbSource: string | null }): boolean =>
  c.climbM !== 0 && c.climbSource !== "computed";

/** What a writer stores for a climb someone stated: above 0 it is theirs, else there is none (the way back to the computed one). */
export function statedClimb(climb: number | null | undefined, source: "manual" | "file"): { climbM: number; climbSource: string | null } {
  const m = climb == null || !Number.isFinite(climb) ? 0 : Math.round(climb);
  return m > 0 ? { climbM: m, climbSource: source } : { climbM: 0, climbSource: null };
}

/** The `map_heightfields.source` of the field §3 picks. */
export function climbFieldSource(pick: ClimbFieldPick): string {
  if (!pick.provider) return HEIGHTFIELD_SOURCE;
  return `${pick.basis === "ground" ? "ground" : "contours"}.${pick.provider.id}`;
}

/**
 * The climb to store for a course's legs, whole metres; null when there
 * is none to state: no legs, no length, a partial profile (the total
 * would be a lower bound) or a climb that rounds to 0.
 */
export function computedClimbM(legs: readonly { points: readonly PaperPoint[] }[], sampler: TerrainSampler): number | null {
  if (legs.length === 0) return null;
  const profile = courseProfile(legs, sampler);
  if (profile.lengthM <= 0 || profile.partial) return null;
  const m = Math.round(profile.climbM);
  return m > 0 ? m : null;
}

// Decoded fields by `hash/source/version`: rows are immutable, so nothing invalidates an entry.
const FIELD_CACHE_ENTRIES = 2;
const fields = new Map<string, HeightField>();

/** For tests. */
export function resetClimbFields(): void {
  fields.clear();
}

/** What a sampler rests on: the pinned document and the confirmed interval. Cheap; read again inside a course's transaction. */
export async function climbInputsStamp(db: Db, eventId: bigint): Promise<string> {
  const pin = await eventPin(db, eventId);
  if (!pin?.documentHash) return "none";
  return `${pin.documentHash}|${(await eventContourInterval(db, pin)).confirmedM ?? "-"}`;
}

/** The event's climb field as a sampler, from stored bytes only; null without a pin, a pick or stored bytes. */
export async function climbSamplerFor(db: Db, eventId: bigint): Promise<TerrainSampler | null> {
  const pin = await eventPin(db, eventId);
  if (!pin?.documentHash) return null;
  const interval = await eventContourInterval(db, pin);
  const terrain = await terrainDescriptor(db, pin.documentHash, undefined, { rotationCorrection: pin.rotationCorrection, confirmedIntervalM: interval.confirmedM });
  const pick = pickClimbField(terrain);
  if (!pick) return null;
  // A climb on the contours rests on the map's interval: unconfirmed, it is an estimate and nothing is stored (§3, §0.43).
  if (pick.basis === "contours" && !pick.interval?.confirmed) return null;
  const source = climbFieldSource(pick);
  const key = `${pin.documentHash}/${source}/${TERRAIN_VERSION}`;
  let field = fields.get(key);
  if (field) {
    fields.delete(key);
    fields.set(key, field);
  } else {
    const row = await readHeightfield(db, pin.documentHash, TERRAIN_VERSION, source);
    if (!row?.bytes) return null;
    field = decodeHeightField(new Uint8Array(row.bytes));
    fields.set(key, field);
    while (fields.size > FIELD_CACHE_ENTRIES) fields.delete(fields.keys().next().value as string);
  }
  return fieldSampler(field, pick.interval ? { intervalM: pick.interval.m } : {});
}

/** A course with no climb to state: empty and not a computed one (a typed source over an empty value is no climb, §6 "Read rule"). */
const OPEN_CLIMB = { climbM: 0, OR: [{ climbSource: null }, { climbSource: { not: "computed" } }] };

/**
 * Computes and stores the climb of the event's live ordered courses that
 * have none (§6 "The compute"). Call after the edit's transaction has
 * committed, with the root client. One short transaction per course,
 * locking that course's row only. Returns the number of courses written.
 */
export async function computeMissingClimbs(db: PrismaClient, eventId: bigint, courseUuids?: readonly string[]): Promise<number> {
  if (courseUuids && courseUuids.length === 0) return 0;
  // Not the lease holder: the holder computes (§6 "During a lease").
  if (!(await mayRunBackgroundJob(db, eventId, "course-climb"))) return 0;
  const open = await db.course.findMany({
    where: { eventId, removed: false, orderMode: "ordered", ...OPEN_CLIMB, ...(courseUuids ? { id: { in: [...courseUuids] } } : {}) },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (open.length === 0) return 0;
  // Taken before the sampler is built: an interval or a map that changes meanwhile shows in the stamp.
  const inputs = await climbInputsStamp(db, eventId);
  const sampler = await climbSamplerFor(db, eventId);
  if (!sampler) return 0;
  let written = 0;
  // The event's chosen routes are read once; each course's transaction re-reads only their stamp and
  // reloads them when a route was chosen meanwhile (a read hoisted without that would race a choice).
  let stamp = await chosenRoutesStamp(db, eventId);
  let chosen = await chosenLegRoutes(db, eventId);
  for (const { id } of open) {
    written += await db.$transaction(async (tx) => {
      // A checkout can start between two courses.
      if (!(await mayRunBackgroundJob(tx, eventId, "course-climb"))) return 0;
      // The map or its interval changed since the sampler was built: nothing is stored at the old one
      // (the change's own clear and compute follow).
      if ((await climbInputsStamp(tx, eventId)) !== inputs) return 0;
      // Locked: an edit of this course waits, then clears what is written here and computes again.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "oxygen"."courses"
        WHERE "id" = ${id}::uuid AND "removed" = false AND "order_mode" = 'ordered'
          AND "climb_m" = 0 AND ("climb_source" IS NULL OR "climb_source" <> 'computed')
        FOR UPDATE`;
      if (locked.length === 0) return 0;
      const found = (await loadCourseSequences(tx, eventId, [id])).get(id);
      if (!found || found.orderMode !== "ordered") return 0;
      // Along the pair's chosen route where a leg has one (§7.3), else the drawn line.
      const now = await chosenRoutesStamp(tx, eventId);
      if (now !== stamp) {
        chosen = await chosenLegRoutes(tx, eventId);
        stamp = now;
      }
      const legs = climbLegsOf(id, found.seq, chosen);
      const climbM = computedClimbM(legs, sampler);
      if (climbM === null) return 0;
      await tx.course.update({ where: { id }, data: { climbM, climbSource: "computed" } });
      // The climb is not part of the course's concurrency token: the editor's next write is not refused for it.
      await emitCourseUpserted(tx, eventId, id, { advanceVersion: false });
      return 1;
    });
  }
  return written;
}

/** After a request: the climbs of the courses its geometry rebuilds marked. */
export async function refreshMarkedClimbs(db: PrismaClient, marks: ClimbMarks): Promise<number> {
  let written = 0;
  for (const [eventId, ids] of marks) written += await refreshComputedClimbs(db, eventId, ids === "all" ? undefined : [...ids]);
  return written;
}

/** `computeMissingClimbs`, failing soft: an error is logged and the courses have no climb until the next edit. */
export async function refreshComputedClimbs(db: PrismaClient, eventId: bigint, courseUuids?: readonly string[]): Promise<number> {
  try {
    return await computeMissingClimbs(db, eventId, courseUuids);
  } catch (err) {
    console.warn(`[course-climb] climbs of event ${eventId} not computed:`, err);
    return 0;
  }
}
