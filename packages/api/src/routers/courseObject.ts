/**
 * `courseObject.*` (docs/course-layer.md §8.4; research 08 §4.5, §6):
 * scoped purple / white objects of the event. Reads are kiosk-readable
 * (the venue map draws them); writes need `courses.edit` and are not
 * lease-guarded — objects are cloud-owned non-critical data (08 §4.8), like
 * the sheets, and reach a venue at checkout. Per-object last-write-wins
 * with the §7 token: `update` / `delete` with a stale `baseVersion` are a
 * `CONFLICT` carrying the object now (`differing` is always null — there is
 * no journal entry to read the client's base from).
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { course } from "@oxygen/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { coursesEditProcedure, kioskOrCoursesViewProcedure, router } from "../trpc.js";
import { baseVersionSchema, lockCourseObjectVersion, versionConflict } from "../version-conflict.js";
import {
  assertWritableKind,
  loadCourseObjects,
  loadWireContext,
  nextObjectVersion,
  storedObjectOf,
  storedScope,
  toWire,
  writeCourseObject,
  type StoredCourseObject,
  type WireContext,
} from "../course-objects.js";

const scopeWireSchema = course.courseObjectScopeSchemaOf(z.number().int());
const zSchema = z.number().int().min(-1_000_000).max(1_000_000);
const json = (v: unknown) => v as Prisma.InputJsonValue;

type Db = Parameters<typeof loadCourseObjects>[0];

async function findObject(db: Db, eventId: bigint, seq: number): Promise<StoredCourseObject> {
  const row = await db.courseObject.findFirst({ where: { eventId, seq } });
  const o = row && storedObjectOf(row);
  if (!o) throw new TRPCError({ code: "NOT_FOUND", message: `Course object ${seq} not found` });
  return o;
}

/** Lock the row; a stale `baseVersion` is a version `CONFLICT` with the object now. */
async function assertObjectVersion(db: Db, eventId: bigint, o: StoredCourseObject, w: WireContext, baseVersion: string | undefined): Promise<void> {
  if (baseVersion === undefined) return;
  const version = await lockCourseObjectVersion(db, o.id);
  if (version === null || version === BigInt(baseVersion)) return;
  const now = await findObject(db, eventId, o.seq);
  throw versionConflict({ kind: "object", id: o.seq, version: version.toString(), current: toWire(now, w), differing: null });
}

export const courseObjectRouter = router({
  /** The event's objects in draw order (`z`, then `seq`). */
  list: kioskOrCoursesViewProcedure.query(async ({ ctx }): Promise<course.CourseObject[]> => {
    const [objects, w] = await Promise.all([loadCourseObjects(ctx.db, ctx.event.id), loadWireContext(ctx.db, ctx.event.id)]);
    return objects.map((o) => toWire(o, w));
  }),

  create: coursesEditProcedure
    .input(course.courseObjectBodySchema.and(z.object({ scope: scopeWireSchema, z: zSchema.optional() })))
    .mutation(async ({ ctx, input }): Promise<course.CourseObject> => {
      const { scope, z: zIndex, ...body } = input;
      const w = await loadWireContext(ctx.db, ctx.event.id);
      const o = await writeCourseObject(ctx.db, ctx.event.id, { body: body as course.CourseObjectBody, scope: storedScope(scope, w.ids), z: zIndex });
      return toWire(o, w);
    }),

  /** Replace geometry, props, scope or `z`; the kind is fixed. */
  update: coursesEditProcedure
    .input(
      z.object({
        id: z.number().int(),
        baseVersion: baseVersionSchema.optional(),
        geometry: z.unknown().optional(),
        props: z.unknown().optional(),
        scope: scopeWireSchema.optional(),
        z: zSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<course.CourseObject> => {
      const w = await loadWireContext(ctx.db, ctx.event.id);
      return ctx.db.$transaction(async (tx) => {
        const o = await findObject(tx, ctx.event.id, input.id);
        await assertObjectVersion(tx, ctx.event.id, o, w, input.baseVersion);
        // An absent field keeps the stored one; anything sent (null included) is validated.
        const parsed = course.courseObjectBodySchema.safeParse({
          kind: o.kind,
          geometry: input.geometry !== undefined ? input.geometry : o.geometry,
          props: input.props !== undefined ? input.props : o.props,
        });
        if (!parsed.success) {
          throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        }
        assertWritableKind(parsed.data.kind);
        const row = await tx.courseObject.update({
          where: { id: o.id },
          data: {
            geometry: json(parsed.data.geometry),
            props: json(parsed.data.props),
            ...(input.scope ? { scope: json(storedScope(input.scope, w.ids)) } : {}),
            ...(input.z !== undefined ? { z: input.z } : {}),
            version: nextObjectVersion(),
          },
        });
        return toWire(storedObjectOf(row)!, w);
      });
    }),

  delete: coursesEditProcedure
    .input(z.object({ id: z.number().int(), baseVersion: baseVersionSchema.optional() }))
    .mutation(async ({ ctx, input }): Promise<{ id: number }> => {
      const w = await loadWireContext(ctx.db, ctx.event.id);
      await ctx.db.$transaction(async (tx) => {
        const o = await findObject(tx, ctx.event.id, input.id);
        await assertObjectVersion(tx, ctx.event.id, o, w, input.baseVersion);
        await tx.courseObject.delete({ where: { id: o.id } });
      });
      return { id: input.id };
    }),

  /**
   * Draw order: `z` = the position in `ids` for the listed objects. Takes
   * and advances no token — the order is not an edit two users race on.
   */
  reorder: coursesEditProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1) }))
    .mutation(async ({ ctx, input }): Promise<course.CourseObject[]> => {
      if (new Set(input.ids).size !== input.ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Duplicate ids" });
      await ctx.db.$transaction(async (tx) => {
        const rows = await tx.courseObject.findMany({ where: { eventId: ctx.event.id, seq: { in: input.ids } }, select: { id: true, seq: true } });
        if (rows.length !== input.ids.length) {
          const known = new Set(rows.map((r) => r.seq));
          throw new TRPCError({ code: "NOT_FOUND", message: `Course objects not found: ${input.ids.filter((i) => !known.has(i)).join(", ")}` });
        }
        const uuid = new Map(rows.map((r) => [r.seq, r.id]));
        for (const [z, seq] of input.ids.entries()) await tx.courseObject.update({ where: { id: uuid.get(seq)! }, data: { z } });
      });
      const [objects, w] = await Promise.all([loadCourseObjects(ctx.db, ctx.event.id), loadWireContext(ctx.db, ctx.event.id)]);
      return objects.map((o) => toWire(o, w));
    }),
});
