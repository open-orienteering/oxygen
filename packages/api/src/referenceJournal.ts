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
 * of inflating every journal entry.
 */

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import type { ReferenceUpsertPayload } from "@oxygen/shared";
import { appendJournal } from "./journalEmit.js";

type Db = PrismaClient | Prisma.TransactionClient;

const STRIP = new Set(["id", "eventId", "seq", "createdAt", "updatedAt"]);

function portableFields(
  row: Record<string, unknown>,
  extraStrip: readonly string[] = [],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([k, v]) => !STRIP.has(k) && !extraStrip.includes(k) && v !== undefined,
    ),
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
    select: { position: true, controlId: true },
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

/** Re-read + journal a course row. Call inside the mutating transaction. */
export async function emitCourseUpserted(
  db: Db,
  eventId: bigint,
  courseUuid: string,
): Promise<void> {
  await appendJournal(db, {
    eventId,
    type: "course.upserted",
    payload: await courseUpsertPayload(db, courseUuid),
  });
}

/** Re-read + journal a control row. Call inside the mutating transaction. */
export async function emitControlUpserted(
  db: Db,
  eventId: bigint,
  controlUuid: string,
): Promise<void> {
  await appendJournal(db, {
    eventId,
    type: "control.upserted",
    payload: await controlUpsertPayload(db, controlUuid),
  });
}
