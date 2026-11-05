/**
 * Optimistic concurrency for course, control and course-object writes
 * (docs/course-layer.md §7, §8.4; gate G1).
 *
 * A client edits from a row's `version` (the HLC of the journal entry that
 * last wrote it) and sends it back as `baseVersion`. Inside the write
 * transaction the row is locked (`FOR UPDATE`, so two writers on one row
 * serialise) and its token compared; a stale one is refused with tRPC
 * `CONFLICT` whose `data` is `VersionConflictData` (`errorFormatter` in
 * trpc.ts copies it from the cause). `baseVersion` is optional for one
 * release: a client that sends none keeps last-write-wins.
 *
 * `differing` compares the client's base with the row now. The base is read
 * from the journal — the `*.upserted` entry whose HLC is `baseVersion`
 * carries the row as the client saw it. When that entry is not on this node
 * (token 0, written before D0, or pruned) `differing` is null.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import type { ReferenceUpsertPayload, VersionConflictData } from "@oxygen/shared";

type Db = PrismaClient | Prisma.TransactionClient;

/** `baseVersion` on the wire: a decimal HLC. */
export const baseVersionSchema = z.string().regex(/^\d+$/, "baseVersion must be a decimal integer");

/** The `cause` of a version `CONFLICT`; `errorFormatter` lifts `data` into the error shape. */
export class VersionConflictError extends Error {
  constructor(readonly data: VersionConflictData) {
    super(`${data.kind} ${data.id} changed elsewhere (version ${data.version})`);
    this.name = "VersionConflictError";
  }
}

export function versionConflict(data: VersionConflictData): TRPCError {
  const err = new VersionConflictError(data);
  return new TRPCError({ code: "CONFLICT", message: err.message, cause: err });
}

/** Lock a course row for the rest of the transaction and return its token. */
export async function lockCourseVersion(db: Db, courseUuid: string): Promise<bigint> {
  const rows = await db.$queryRaw<{ version: bigint }[]>`
    SELECT "version" FROM "oxygen"."courses" WHERE "id" = ${courseUuid}::uuid FOR UPDATE`;
  return rows[0]?.version ?? 0n;
}

/** Lock a control row for the rest of the transaction and return its token. */
export async function lockControlVersion(db: Db, controlUuid: string): Promise<bigint> {
  const rows = await db.$queryRaw<{ version: bigint }[]>`
    SELECT "version" FROM "oxygen"."controls" WHERE "id" = ${controlUuid}::uuid FOR UPDATE`;
  return rows[0]?.version ?? 0n;
}

/** Lock a course object row (§8.4) and return its token; null when the row is gone. */
export async function lockCourseObjectVersion(db: Db, objectUuid: string): Promise<bigint | null> {
  const rows = await db.$queryRaw<{ version: bigint }[]>`
    SELECT "version" FROM "oxygen"."course_objects" WHERE "id" = ${objectUuid}::uuid FOR UPDATE`;
  return rows[0]?.version ?? null;
}

/** The row as the client saw it: the payload of the `*.upserted` entry at `baseVersion`, if this node has it. */
export async function basePayload(
  db: Db,
  eventId: bigint,
  type: "course.upserted" | "control.upserted",
  rowUuid: string,
  baseVersion: string,
): Promise<ReferenceUpsertPayload | null> {
  const hlc = BigInt(baseVersion);
  if (hlc === 0n) return null;
  const entries = await db.journalEntry.findMany({
    where: { eventId, type, hlc },
    select: { payload: true },
  });
  for (const e of entries) {
    const p = e.payload as unknown as ReferenceUpsertPayload;
    if (p?.id === rowUuid) return p;
  }
  return null;
}

/** Control fields a conflict reports on (`differing`): the ones an editor shows or writes. */
export const CONTROL_CONFLICT_FIELDS = [
  "name",
  "codes",
  "status",
  "kind",
  "xpos",
  "ypos",
  "description",
  "circleGaps",
  "notes",
  "checkedAt",
  "radioType",
  "airPlus",
  "timeAdjust",
  "minTime",
  "removed",
] as const;

function normalise(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === "bigint") return v.toString();
  return JSON.stringify(v ?? null);
}

/** Field names whose values differ between two control field maps. */
export function controlFieldsDiff(
  base: Record<string, unknown>,
  current: Record<string, unknown>,
  fields: readonly string[] = CONTROL_CONFLICT_FIELDS,
): string[] {
  return fields.filter((f) => f in base && normalise(base[f]) !== normalise(current[f]));
}
