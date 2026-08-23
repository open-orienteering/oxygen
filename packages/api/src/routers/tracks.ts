/**
 * Tracks router — GPS route lookups for the Tracks page and replay viewer.
 *
 * Read-only over the `routes` table. Routes are source-agnostic: the
 * `sourceType` column records where a track came from, and nothing in this
 * router talks to any external service.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";

export const tracksRouter = router({
  listRoutes: eventProcedure.query(async ({ ctx }) => {
    const routes = await ctx.db.route.findMany({
      where: { eventId: ctx.event.id },
      include: {
        runner: { select: { name: true, clubName: true, seq: true } },
        class: { select: { name: true, seq: true } },
      },
      orderBy: { syncedAt: "desc" },
    });
    type RouteResult = {
      status: "ok" | "mp" | "dnf" | "dns" | "dq" | "unknown";
      timeMs?: number;
      rank?: number;
      splitTimes?: { controlCode: string; timeMs: number }[];
    };
    return routes.map((r) => ({
      id: Number(r.id),
      runnerId: r.runner?.seq ?? null,
      runnerName: r.runner?.name ?? "",
      organisation: r.runner?.clubName ?? "",
      classId: r.class?.seq ?? null,
      className: r.class?.name ?? "",
      sourceType: r.sourceType,
      color: r.color,
      raceStartMs: r.raceStartMs != null ? Number(r.raceStartMs) : null,
      result: (r.result as RouteResult | null) ?? null,
      syncedAt: r.syncedAt.toISOString(),
    }));
  }),

  /**
   * One row per class that has synced routes, with a human-readable
   * className alongside so the TracksPage filter chips can render without
   * an additional class lookup.
   */
  listSyncedClasses: eventProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.route.groupBy({
      by: ["classId"],
      where: { eventId: ctx.event.id },
      _count: { id: true },
      _max: { syncedAt: true },
    });
    const classIds = rows
      .map((r) => r.classId)
      .filter((id): id is string => !!id);
    const classes = classIds.length
      ? await ctx.db.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true, seq: true },
        })
      : [];
    const byId = new Map(classes.map((c) => [c.id, c]));
    return rows.map((r) => {
      const cls = r.classId ? byId.get(r.classId) ?? null : null;
      return {
        classId: cls?.seq ?? null,
        className: cls?.name ?? "",
        routeCount: r._count.id,
        syncedAt: r._max.syncedAt?.toISOString() ?? null,
      };
    });
  }),

  /** Delete a single route by its numeric id. */
  deleteRoute: eventProcedure
    .input(z.object({ routeId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.route.delete({ where: { id: BigInt(input.routeId) } });
      return { ok: true as const };
    }),

  /**
   * Fetch the GPS waypoints for a single route so the TracksPage
   * "expanded row" can overlay one runner on the map.
   */
  getRoutePreview: eventProcedure
    .input(z.object({ routeId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const route = await ctx.db.route.findUnique({
        where: { id: BigInt(input.routeId) },
        include: {
          class: { select: { name: true } },
          runner: { select: { name: true } },
        },
      });
      if (!route || route.eventId !== ctx.event.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Route ${input.routeId} not found`,
        });
      }
      const waypoints =
        ((route.waypoints as unknown) as Array<{ lat: number; lng: number; t?: number }> | null) ??
        [];
      return {
        id: Number(route.id),
        // The TracksPage uses `courseName` to highlight the matching
        // course overlay; we surface the className the route belongs to.
        courseName: route.class?.name ?? "",
        runnerName: route.runner?.name ?? "",
        waypoints,
        color: route.color,
        raceStartMs: route.raceStartMs != null ? Number(route.raceStartMs) : null,
      };
    }),

  /** Bulk fetch of route GPS data for a whole class. */
  getClassRoutes: eventProcedure
    .input(z.object({ classId: z.number().int().optional() }))
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = { eventId: ctx.event.id };
      if (input.classId) {
        const cls = await ctx.db.class.findFirst({
          where: { eventId: ctx.event.id, seq: input.classId, removed: false },
          select: { id: true },
        });
        if (!cls) return [];
        where.classId = cls.id;
      }
      const routes = await ctx.db.route.findMany({
        where,
        include: {
          runner: { select: { seq: true, name: true, clubName: true } },
        },
        orderBy: { syncedAt: "desc" },
      });
      return routes.map((r) => ({
        id: Number(r.id),
        runnerId: r.runner?.seq ?? null,
        runnerName: r.runner?.name ?? "",
        organisation: r.runner?.clubName ?? "",
        color: r.color,
        raceStartMs: r.raceStartMs != null ? Number(r.raceStartMs) : null,
        waypoints:
          ((r.waypoints as unknown) as Array<{ lat: number; lng: number; t?: number }> | null) ?? [],
      }));
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
