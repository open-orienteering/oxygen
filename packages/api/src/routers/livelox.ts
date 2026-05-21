/**
 * Livelox integration router — config + sync trigger stubs.
 * The fetcher / decoder / transform pipeline in src/livelox/ stays put
 * (it has no DB dependency); the route-writeback into `routes` is the
 * piece pending a re-port.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure, publicProcedure } from "../trpc.js";
import type { ReplayData } from "@oxygen/shared";

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

  /**
   * Standalone Livelox class viewer entry. The web page expects a
   * `ReplayData` payload; the full Livelox fetch+transform pipeline is
   * staged, so for now we throw with a typed return so the page can
   * render its "Failed to load map" graceful fallback.
   */
  importClass: publicProcedure
    .input(z.object({ classId: z.number().int() }))
    .query(async (): Promise<ReplayData> => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Livelox class import pending re-port.",
      });
    }),

  /** Sync trigger (alias of syncRoutes). */
  sync: eventProcedure.mutation(async () => {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Livelox sync pending re-port.",
    });
  }),

  /** Route by runner seq. */
  routeByRunner: eventProcedure
    .input(z.object({ runnerId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, seq: input.runnerId, removed: false },
        select: { id: true },
      });
      if (!runner) return null;
      const route = await ctx.db.route.findFirst({
        where: { eventId: ctx.event.id, runnerId: runner.id },
        orderBy: { syncedAt: "desc" },
      });
      if (!route) return null;
      return {
        id: Number(route.id),
        sourceType: route.sourceType,
        color: route.color,
        raceStartMs: route.raceStartMs != null ? Number(route.raceStartMs) : null,
        waypoints: route.waypoints,
        interruptions: route.interruptions,
        result: route.result,
        syncedAt: route.syncedAt.toISOString(),
      };
    }),
});
