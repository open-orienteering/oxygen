/**
 * External public-read API — used by the kiosk + start-screen pages where
 * the client is read-only and may not authenticate. Minimal port of the
 * previous module; deeper status / leaderboard endpoints follow the
 * cardReadout matcher port.
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";

export const externalRouter = router({
  /** Public event metadata. */
  event: eventProcedure.query(async ({ ctx }) => {
    const e = await ctx.db.event.findUnique({ where: { id: ctx.event.id } });
    if (!e) return null;
    return {
      name: e.name,
      annotation: e.annotation,
      date: e.date.toISOString().slice(0, 10),
      zeroTime: e.zeroTime,
    };
  }),

  /** Public class roster (id + name). */
  classes: eventProcedure.query(async ({ ctx }) => {
    const classes = await ctx.db.class.findMany({
      where: { eventId: ctx.event.id, removed: false },
      orderBy: { sortIndex: "asc" },
      select: { seq: true, name: true },
    });
    return classes.map((c) => ({ id: c.seq, name: c.name }));
  }),

  /** Public start list (sorted by start time / start no). */
  startList: eventProcedure
    .input(z.object({ classId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
      };
      if (input?.classId) {
        const cls = await ctx.db.class.findFirst({
          where: { eventId: ctx.event.id, seq: input.classId },
          select: { id: true },
        });
        if (!cls) return [];
        where.classId = cls.id;
      }
      const runners = await ctx.db.runner.findMany({
        where,
        select: {
          seq: true,
          name: true,
          clubName: true,
          startNo: true,
          startTime: true,
          cardNo: true,
          class: { select: { name: true } },
        },
        orderBy: [{ startTime: "asc" }, { startNo: "asc" }],
      });
      return runners.map((r) => ({
        id: r.seq,
        name: r.name,
        clubName: r.clubName,
        className: r.class?.name ?? "",
        startNo: r.startNo,
        startTime: r.startTime, // ZeroTime-relative; client should add zeroTime
        cardNo: r.cardNo,
      }));
    }),
});
