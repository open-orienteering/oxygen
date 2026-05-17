/**
 * Registration Trends — Eventor-driven historical entry curves.
 * Reads from the global eventor_event_meta / eventor_entry_history cache.
 * Refresh-from-Eventor is staged with the rest of the eventor sync re-port.
 */

import { z } from "zod";
import { router, publicProcedure, eventProcedure } from "../trpc.js";
import { prisma } from "../db.js";

export const registrationTrendsRouter = router({
  /** Curve for the active event (entry-count vs time). */
  ownTimeline: eventProcedure.query(async ({ ctx }) => {
    const runners = await ctx.db.runner.findMany({
      where: { eventId: ctx.event.id, removed: false, entryDate: { gt: 0 } },
      select: { entryDate: true, entryTime: true },
    });
    // Group by day; pre-cache a cumulative curve for the trends page.
    const byDay = new Map<string, number>();
    for (const r of runners) {
      const y = Math.floor(r.entryDate / 10000);
      const m = Math.floor((r.entryDate % 10000) / 100);
      const d = r.entryDate % 100;
      if (y < 1900) continue;
      const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    const days = [...byDay.keys()].sort();
    let cumulative = 0;
    return days.map((day) => {
      cumulative += byDay.get(day) ?? 0;
      return { day, cumulative };
    });
  }),

  /** Look up a specific Eventor event by id (lazy fetch into cache). */
  lookupEventorEvent: publicProcedure
    .input(z.object({ eventorEventId: z.number().int() }))
    .mutation(async ({ input }) => {
      const row = await prisma().eventorEventMeta.findUnique({
        where: { eventorEventId: input.eventorEventId },
      });
      if (!row) return null;
      return {
        eventorEventId: row.eventorEventId,
        name: row.name,
        startDate: row.startDate.toISOString().slice(0, 10),
        organiser: row.organiser,
        entryCount: row.entryCount,
        fetchedAt: row.fetchedAt.toISOString(),
      };
    }),

  /** Find Eventor events comparable to the active one (same kind, region). */
  findComparableEvents: publicProcedure
    .input(z.object({ classificationId: z.number().int().optional() }).optional())
    .query(async ({ input }) => {
      const rows = await prisma().eventorEventMeta.findMany({
        where: input?.classificationId
          ? { classificationId: input.classificationId }
          : undefined,
        orderBy: { startDate: "desc" },
        take: 50,
      });
      return rows.map((r) => ({
        eventorEventId: r.eventorEventId,
        name: r.name,
        startDate: r.startDate.toISOString().slice(0, 10),
        organiser: r.organiser,
        entryCount: r.entryCount,
      }));
    }),

  /** Pull comparison data for a specific Eventor event (stub). */
  fetchComparison: publicProcedure
    .input(z.object({ eventorEventId: z.number().int() }))
    .mutation(async ({ input }) => {
      const history = await prisma().eventorEntryHistory.findMany({
        where: { eventorEventId: input.eventorEventId },
        orderBy: { rowSeq: "asc" },
      });
      return history.map((h) => ({
        rowSeq: h.rowSeq,
        entryAt: h.entryAt.toISOString(),
        entryClassId: h.entryClassId,
      }));
    }),

  listCachedEvents: publicProcedure.query(async () => {
    const rows = await prisma().eventorEventMeta.findMany({
      orderBy: { startDate: "desc" },
    });
    return rows.map((r) => ({
      eventorEventId: r.eventorEventId,
      name: r.name,
      startDate: r.startDate.toISOString().slice(0, 10),
      organiser: r.organiser,
      entryCount: r.entryCount,
      fetchedAt: r.fetchedAt.toISOString(),
    }));
  }),

  entryHistory: publicProcedure
    .input(z.object({ eventorEventId: z.number().int() }))
    .query(async ({ input }) => {
      const rows = await prisma().eventorEntryHistory.findMany({
        where: { eventorEventId: input.eventorEventId },
        orderBy: { rowSeq: "asc" },
      });
      return rows.map((r) => ({
        rowSeq: r.rowSeq,
        entryClassId: r.entryClassId,
        entryAt: r.entryAt.toISOString(),
      }));
    }),
});
