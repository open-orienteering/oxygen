/**
 * `legRoute.*` (docs/course-elevation.md §7.2): the event's leg routes —
 * a route per directed control pair, shared by every course that runs
 * the pair. Ids on the wire are public: a route by its UUID, a control
 * by its public id (its first code, else its seq). Every write that changes what a pair's climb
 * is read along clears the computed climb of the courses running the
 * pair, in its transaction; it is computed again after the commit (§6).
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { course } from "@oxygen/shared";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { coursesEditRaceProcedure, coursesViewProcedure, router } from "../trpc.js";
import { clearComputedClimbs } from "../course-geometry.js";
import { coursesRunningPair } from "../leg-routes.js";
import { publicControlId } from "../control-id.js";
import { uuidsOfPublicIds } from "../course-structure.js";

type Tx = Prisma.TransactionClient;

export interface LegRouteWire {
  id: string;
  fromControlId: number;
  toControlId: number;
  points: course.RoutePoint[];
  source: course.LegRouteSource;
  model: string | null;
  chosen: boolean;
}

const ROW = { id: true, points: true, source: true, model: true, chosen: true, fromControlId: true, toControlId: true, from: { select: { seq: true, codes: true } }, to: { select: { seq: true, codes: true } } } as const;
type Row = Prisma.LegRouteGetPayload<{ select: typeof ROW }>;

function toWire(r: Row): LegRouteWire {
  const points = course.legRoutePointsSchema.safeParse(r.points);
  return {
    id: r.id, fromControlId: publicControlId(r.from), toControlId: publicControlId(r.to), points: points.success ? points.data : [],
    source: r.source === "computed" ? "computed" : "drawn", model: r.model, chosen: r.chosen,
  };
}

/** A control's row by its public id (`publicControlId`: its first code, else its seq). */
async function controlUuid(db: PrismaClient | Tx, eventId: bigint, publicId: number): Promise<string> {
  const id = (await uuidsOfPublicIds(db, eventId, [publicId])).get(publicId);
  if (!id) throw new TRPCError({ code: "NOT_FOUND", message: `Control ${publicId} not found` });
  return id;
}

async function findRoute(db: PrismaClient | Tx, eventId: bigint, id: string): Promise<Row> {
  const r = await db.legRoute.findFirst({ where: { id, eventId }, select: ROW });
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Route not found" });
  return r;
}

/** The pair's climb changed: the courses running it are cleared here and computed after the commit. */
async function pairChanged(tx: Tx, eventId: bigint, from: string, to: string): Promise<void> {
  await clearComputedClimbs(tx, eventId, await coursesRunningPair(tx, eventId, from, to));
}

/** Two writers choosing a route for one pair at once: the second meets the one-chosen index (§7.2). */
async function oneChoice<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      throw new TRPCError({ code: "CONFLICT", message: "The leg's route was changed at the same time; try again" });
    throw err;
  }
}

const idInput = z.object({ id: z.string().uuid() });

export const legRouteRouter = router({
  /** Every route of the event between live controls, a pair's routes together, oldest first. */
  list: coursesViewProcedure.query(async ({ ctx }): Promise<LegRouteWire[]> => {
    const rows = await ctx.db.legRoute.findMany({
      where: { eventId: ctx.event.id, from: { removed: false }, to: { removed: false } },
      select: ROW,
      orderBy: [{ fromControlId: "asc" }, { toControlId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toWire);
  }),

  /**
   * Store a route: a new one for the pair, or new points for route `id`.
   * A new route is chosen unless `chosen` is false; choosing it takes the
   * choice from the pair's other routes.
   */
  save: coursesEditRaceProcedure
    .input(z.object({
      id: z.string().uuid().optional(),
      fromControlId: z.number().int(),
      toControlId: z.number().int(),
      points: course.legRoutePointsSchema,
      source: z.enum(course.LEG_ROUTE_SOURCES).default("drawn"),
      model: z.string().min(1).max(64).nullable().optional(),
      chosen: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }): Promise<LegRouteWire> => {
      const eventId = ctx.event.id;
      if (input.fromControlId === input.toControlId) throw new TRPCError({ code: "BAD_REQUEST", message: "A route runs between two different controls" });
      return oneChoice(() => ctx.db.$transaction(async (tx) => {
        const [from, to] = [await controlUuid(tx, eventId, input.fromControlId), await controlUuid(tx, eventId, input.toControlId)];
        const existing = input.id ? await findRoute(tx, eventId, input.id) : null;
        if (existing && (existing.fromControlId !== from || existing.toControlId !== to)) throw new TRPCError({ code: "BAD_REQUEST", message: "A route keeps its pair" });
        const chosen = input.chosen ?? existing?.chosen ?? true;
        if (chosen) await tx.legRoute.updateMany({ where: { eventId, fromControlId: from, toControlId: to, chosen: true, ...(existing ? { id: { not: existing.id } } : {}) }, data: { chosen: false } });
        const data = { points: input.points, source: input.source, model: input.source === "computed" ? input.model ?? null : null, chosen };
        const row = existing
          ? await tx.legRoute.update({ where: { id: existing.id }, data, select: ROW })
          : await tx.legRoute.create({ data: { ...data, eventId, fromControlId: from, toControlId: to }, select: ROW });
        // A route that is not the chosen one, before and after, changes no climb.
        if (chosen || existing?.chosen) await pairChanged(tx, eventId, from, to);
        return toWire(row);
      }));
    }),

  /** Choose the route for its pair (the pair's other routes are not), or take the choice away: the pair is read along its drawn line again. */
  choose: coursesEditRaceProcedure
    .input(idInput.extend({ chosen: z.boolean() }))
    .mutation(async ({ ctx, input }): Promise<LegRouteWire> => {
      const eventId = ctx.event.id;
      return oneChoice(() => ctx.db.$transaction(async (tx) => {
        const r = await findRoute(tx, eventId, input.id);
        if (r.chosen === input.chosen) return toWire(r);
        if (input.chosen) await tx.legRoute.updateMany({ where: { eventId, fromControlId: r.fromControlId, toControlId: r.toControlId, chosen: true }, data: { chosen: false } });
        const row = await tx.legRoute.update({ where: { id: r.id }, data: { chosen: input.chosen }, select: ROW });
        await pairChanged(tx, eventId, r.fromControlId, r.toControlId);
        return toWire(row);
      }));
    }),

  delete: coursesEditRaceProcedure
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<{ id: string }> => {
      const eventId = ctx.event.id;
      return ctx.db.$transaction(async (tx) => {
        const r = await findRoute(tx, eventId, input.id);
        await tx.legRoute.delete({ where: { id: r.id } });
        if (r.chosen) await pairChanged(tx, eventId, r.fromControlId, r.toControlId);
        return { id: r.id };
      });
    }),
});
