/**
 * Livelox integration router — config + sync triggers + per-runner /
 * per-class route lookups + a standalone class viewer entry.
 *
 * The heavy lifting (HTTP fetch, blob decode, GPS-CRS reprojection,
 * matching against local runners) lives in `src/livelox/`. This router
 * owns the DB writeback into `routes` and the tRPC surface.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure, publicProcedure } from "../trpc.js";
import type { ReplayData } from "@oxygen/shared";
import { syncEvent } from "../livelox/sync.js";
import {
  fetchClassBlob,
  fetchClassInfo,
} from "../livelox/fetcher.js";
import { transformToReplayData } from "../livelox/transform.js";

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

  /**
   * Legacy single-button sync — falls back to whatever liveloxEventId
   * the event is configured with. Returns the same shape as `sync`.
   */
  syncRoutes: eventProcedure.mutation(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveloxEventId: true },
    });
    if (!event?.liveloxEventId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Configure a Livelox event id first.",
      });
    }
    return syncEvent(ctx.db, ctx.event.id, event.liveloxEventId);
  }),

  /**
   * Sync from an explicit Livelox event id. When omitted, falls back
   * to the configured one. Returns `{ classesSynced, routesSynced,
   * unmatched: { runners, classes } }` so the EventPage panel can
   * surface matching diagnostics.
   */
  sync: eventProcedure
    .input(
      z
        .object({ liveloxEventId: z.number().int().positive() })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      let liveloxEventId = input?.liveloxEventId ?? null;
      if (!liveloxEventId) {
        const event = await ctx.db.event.findUnique({
          where: { id: ctx.event.id },
          select: { liveloxEventId: true },
        });
        liveloxEventId = event?.liveloxEventId ?? null;
      }
      if (!liveloxEventId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Configure a Livelox event id first.",
        });
      }
      return syncEvent(ctx.db, ctx.event.id, liveloxEventId);
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
      liveloxClassId: r.liveloxClassId,
      sourceType: r.sourceType,
      color: r.color,
      raceStartMs: r.raceStartMs != null ? Number(r.raceStartMs) : null,
      result: (r.result as RouteResult | null) ?? null,
      syncedAt: r.syncedAt.toISOString(),
    }));
  }),

  /**
   * One row per (class, liveloxClassId) combination, with a
   * human-readable className alongside so the TracksPage filter chips
   * can render without an additional class lookup.
   */
  listSyncedClasses: eventProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.route.groupBy({
      by: ["classId", "liveloxClassId"],
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
        liveloxClassId: r.liveloxClassId,
        routeCount: r._count.id,
        syncedAt: r._max.syncedAt?.toISOString() ?? null,
      };
    });
  }),

  /**
   * Delete a single route by its numeric id. The legacy UI sends
   * `{ routeId }`; we keep the field name to avoid a follow-up
   * web-side patch.
   */
  deleteRoute: eventProcedure
    .input(z.object({ routeId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.route.delete({ where: { id: BigInt(input.routeId) } });
      return { ok: true as const };
    }),

  /**
   * Fetch the GPS waypoints for a single route so the TracksPage
   * "expanded row" can overlay one runner on the map. Input takes
   * `{ routeId }` because the page tracks expansion by route id, not
   * livelox class id.
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
        // course overlay; we surface the className the route belongs
        // to (1:1 with course in the typical Livelox import flow).
        courseName: route.class?.name ?? "",
        runnerName: route.runner?.name ?? "",
        liveloxClassId: route.liveloxClassId,
        waypoints,
        color: route.color,
        raceStartMs: route.raceStartMs != null ? Number(route.raceStartMs) : null,
      };
    }),

  /**
   * Bulk fetch of route GPS data for the multi-runner class replay
   * page. The legacy version filtered by liveloxClassId; with the new
   * schema we can also filter by our own class UUID (via seq) so
   * `?classId=…` URLs keep working.
   */
  getClassRoutes: eventProcedure
    .input(
      z.object({
        liveloxClassId: z.number().int().optional(),
        classId: z.number().int().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = { eventId: ctx.event.id };
      if (input.liveloxClassId) where.liveloxClassId = input.liveloxClassId;
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
        liveloxClassId: r.liveloxClassId,
        color: r.color,
        raceStartMs: r.raceStartMs != null ? Number(r.raceStartMs) : null,
        waypoints:
          ((r.waypoints as unknown) as Array<{ lat: number; lng: number; t?: number }> | null) ?? [],
      }));
    }),

  /**
   * Standalone Livelox class viewer entry. Drives the public
   * ReplayPage / TracksReplayPage which take a `classId` URL param
   * and render the full live replay (map + GPS routes + splits).
   *
   * The pipeline is: ClassInfo (gives the Azure blob URL) → blob
   * fetch (waypoints + map metadata + participant results) →
   * transform into the wire-level `ReplayData` shape. Tile URLs are
   * rewritten through `/api/livelox-tile` to avoid CORS issues and
   * keep the viewer working when the Livelox CDN rotates URLs.
   *
   * Wrapped in our own TRPCError with the upstream message attached so
   * the page can render its "Failed to load map" fallback gracefully
   * (private / subscriber-only classes, deleted classes, network
   * blips all fall into this path).
   */
  importClass: publicProcedure
    .input(z.object({ classId: z.number().int().positive() }))
    .query(async ({ input }): Promise<ReplayData> => {
      try {
        const info = await fetchClassInfo(input.classId);
        const blob = await fetchClassBlob(info.classBlobUrl);
        return transformToReplayData(blob, {
          eventName: info.eventName,
          className: info.className,
          tileProxyBase: "/api/livelox-tile",
        });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Livelox class import failed";
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: msg,
        });
      }
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
