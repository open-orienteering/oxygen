/**
 * Livelox integration router — config + sync trigger stubs.
 * The fetcher / decoder / transform pipeline in src/livelox/ stays put
 * (it has no DB dependency); the route-writeback into `routes` is the
 * piece pending a re-port.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";

export const liveloxRouter = router({
  getConfig: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveloxEventId: true },
    });
    return { liveloxEventId: event?.liveloxEventId ?? null };
  }),

  setConfig: eventProcedure
    .input(z.object({ liveloxEventId: z.number().int().positive().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.event.update({
        where: { id: ctx.event.id },
        data: { liveloxEventId: input.liveloxEventId },
      });
      return { ok: true as const };
    }),

  syncRoutes: eventProcedure.mutation(async () => {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Livelox route sync is being re-ported against the new schema. Coming back online shortly.",
    });
  }),

  listRoutes: eventProcedure.query(async ({ ctx }) => {
    const routes = await ctx.db.route.findMany({
      where: { eventId: ctx.event.id },
      include: {
        runner: { select: { name: true, clubName: true, seq: true } },
        class: { select: { name: true, seq: true } },
      },
      orderBy: { syncedAt: "desc" },
    });
    return routes.map((r) => ({
      id: Number(r.id),
      runnerId: r.runner?.seq ?? 0,
      runnerName: r.runner?.name ?? "",
      organisation: r.runner?.clubName ?? "",
      classId: r.class?.seq ?? 0,
      className: r.class?.name ?? "",
      liveloxClassId: r.liveloxClassId,
      sourceType: r.sourceType,
      color: r.color,
      raceStartMs: r.raceStartMs != null ? Number(r.raceStartMs) : null,
      syncedAt: r.syncedAt.toISOString(),
    }));
  }),

  listSyncedClasses: eventProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.route.groupBy({
      by: ["classId", "liveloxClassId"],
      where: { eventId: ctx.event.id },
      _count: { id: true },
    });
    return rows.map((r) => ({
      classId: r.classId,
      liveloxClassId: r.liveloxClassId,
      routeCount: r._count.id,
    }));
  }),

  deleteRoute: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.route.delete({ where: { id: BigInt(input.id) } });
      return { ok: true as const };
    }),

  getRoutePreview: eventProcedure
    .input(z.object({ liveloxClassId: z.number().int() }))
    .query(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Livelox route preview pending re-port.",
      });
    }),

  importClass: eventProcedure
    .input(z.object({ liveloxClassId: z.number().int(), classId: z.number().int() }))
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Livelox class import pending re-port.",
      });
    }),
});
