/**
 * Registration Trends — Eventor-driven historical entry curves.
 * Reads from the global `eventor_event_meta` / `eventor_entry_history`
 * cache. Refreshing the cache from Eventor is staged with the rest of the
 * eventor sync re-port.
 */

import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { prisma } from "../db.js";

export const registrationTrendsRouter = router({
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
