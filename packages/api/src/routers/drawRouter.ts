/**
 * Draw router — placeholder for the start-draw engine. Full multi-class
 * corridor-aware algorithm is being re-ported against the new schema.
 *
 * For now `defaults` returns sensible UI defaults so the panel renders;
 * `preview` / `execute` throw PRECONDITION_FAILED.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import { runnerStatusToValue } from "../statusConvert.js";

export const drawRouter = router({
  /** Defaults for the draw config form. */
  defaults: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { zeroTime: true },
    });
    const classes = await ctx.db.class.findMany({
      where: { eventId: ctx.event.id, removed: false },
      include: {
        _count: { select: { runners: { where: { removed: false } } } },
      },
      orderBy: { sortIndex: "asc" },
    });
    return {
      firstStart: event?.zeroTime ?? 324000,
      baseInterval: 600,
      maxParallelStarts: 10,
      detectCourseOverlap: true,
      classes: classes.map((c) => ({
        id: c.seq,
        name: c.name,
        runnerCount: c._count.runners,
        method: "clubSeparation" as const,
        interval: 1200,
      })),
    };
  }),

  preview: eventProcedure
    .input(
      z.object({
        classConfigs: z.array(z.unknown()).optional(),
        settings: z.unknown().optional(),
      }),
    )
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Start-draw engine pending re-port. Coming back online shortly.",
      });
    }),

  execute: eventProcedure
    .input(z.object({ entries: z.array(z.unknown()).optional() }))
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Draw commit pending re-port.",
      });
    }),

  commit: eventProcedure
    .input(z.object({ entries: z.array(z.unknown()).optional() }))
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Draw commit pending re-port.",
      });
    }),
});

// Suppress unused import warning until the algorithm uses it.
void runnerStatusToValue;
