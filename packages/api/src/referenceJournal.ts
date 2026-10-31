/**
 * Reference-data journal emits (classes / courses / controls).
 *
 * Reference entities are LWW registers keyed by their row UUID: every
 * mutation re-reads the post-write row inside the same transaction and
 * journals the FULL portable row (`*.upserted`), so the apply side is a
 * plain upsert with no patch semantics. Soft deletes are upserts with
 * `removed: true`. Child link tables travel with their parent (course →
 * course_controls, class → class_course_pools) and are replaced wholesale
 * on apply.
 *
 * Stripped from the payload: `id`/`eventId`/`seq` (carried explicitly),
 * timestamps (local defaults), and the course `geometry`/`geometrySource`
 * blobs — derived artifacts that travel with the checkout snapshot instead
 * of inflating every journal entry. BigInt columns (`version`) travel as
 * decimal strings.
 *
 * Version token (docs/course-layer.md §7): a course / control row's
 * `version` is the HLC of the `*.upserted` entry that last wrote it. The
 * emit takes the clock reading first, stamps the row with it, then reads the
 * payload — so the entry carries the token it set and a peer applying it
 * ends up with the same token. Re-emits that only ship a rebuilt geometry
 * (a control moved; the event's map or cut settings changed) pass
 * `{ advanceVersion: false }`: the course's structure did not change, so its
 * token does not either (a structure edit and a field move never conflict).
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { encodeHlc, type ReferenceUpsertPayload } from "@oxygen/shared";
import { appendJournal } from "./journalEmit.js";
import { nextServerHlc } from "./serverClock.js";

type Db = PrismaClient | Prisma.TransactionClient;

const STRIP = new Set(["id", "eventId", "seq", "createdAt", "updatedAt"]);

function portableFields(
  row: Record<string, unknown>,
  extraStrip: readonly string[] = [],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([k, v]) => !STRIP.has(k) && !extraStrip.includes(k) && v !== undefined)
      .map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
  );
}

/** Serialize a class row (+ course pools) into its upsert payload. */
export async function classUpsertPayload(
  db: Db,
  classUuid: string,
): Promise<ReferenceUpsertPayload> {
  const row = await db.class.findUniqueOrThrow({ where: { id: classUuid } });
  const pools = await db.classCoursePool.findMany({
    where: { classId: classUuid },
    select: { stage: true, courseId: true },
  });
  return {
    id: row.id,
    seq: row.seq,
    fields: portableFields(row as unknown as Record<string, unknown>),
    coursePools: pools,
  };
}

/** Serialize a course row (+ ordered controls) into its upsert payload. */
export async function courseUpsertPayload(
  db: Db,
  courseUuid: string,
): Promise<ReferenceUpsertPayload> {
  const row = await db.course.findUniqueOrThrow({ where: { id: courseUuid } });
  const ccs = await db.courseControl.findMany({
    where: { courseId: courseUuid },
    orderBy: { position: "asc" },
    select: { position: true, controlId: true, labelDx: true, labelDy: true, numberHidden: true },
  });
  return {
    id: row.id,
    seq: row.seq,
    fields: portableFields(row as unknown as Record<string, unknown>, [
      "geometry",
      "geometrySource",
    ]),
    courseControls: ccs,
  };
}

/** Serialize a control row into its upsert payload. */
export async function controlUpsertPayload(
  db: Db,
  controlUuid: string,
): Promise<ReferenceUpsertPayload> {
  const row = await db.control.findUniqueOrThrow({ where: { id: controlUuid } });
  return {
    id: row.id,
    seq: row.seq,
    fields: portableFields(row as unknown as Record<string, unknown>),
  };
}

/** Re-read + journal a class row. Call inside the mutating transaction. */
export async function emitClassUpserted(
  db: Db,
  eventId: bigint,
  classUuid: string,
): Promise<void> {
  await appendJournal(db, {
    eventId,
    type: "class.upserted",
    payload: await classUpsertPayload(db, classUuid),
  });
}

export interface EmitOptions {
  /** Stamp the row's `version` with this entry's HLC. Default true; false for geometry-only re-emits. */
  advanceVersion?: boolean;
}

/**
 * Re-read + journal a course row. Call inside the mutating transaction.
 * Returns the row's version token after the emit.
 */
export async function emitCourseUpserted(
  db: Db,
  eventId: bigint,
  courseUuid: string,
  opts: EmitOptions = {},
): Promise<bigint> {
  const hlc = nextServerHlc();
  let version: bigint | null = null;
  if (opts.advanceVersion !== false) {
    version = encodeHlc(hlc);
    await db.course.update({ where: { id: courseUuid }, data: { version } });
  }
  const payload = await courseUpsertPayload(db, courseUuid);
  await appendJournal(db, { eventId, type: "course.upserted", payload, hlc });
  return version ?? BigInt(String(payload.fields.version ?? 0));
}

/**
 * Re-read + journal a control row. Call inside the mutating transaction.
 * Returns the row's version token after the emit.
 */
export async function emitControlUpserted(
  db: Db,
  eventId: bigint,
  controlUuid: string,
): Promise<bigint> {
  const hlc = nextServerHlc();
  const version = encodeHlc(hlc);
  await db.control.update({ where: { id: controlUuid }, data: { version } });
  await appendJournal(db, {
    eventId,
    type: "control.upserted",
    payload: await controlUpsertPayload(db, controlUuid),
    hlc,
  });
  return version;
}
