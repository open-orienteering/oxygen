/**
 * Draw router — placeholder for the start-draw engine.
 * Full port of the per-class draw algorithm (club separation, corridor
 * assignment, course-overlap detection) is staged as a follow-up alongside
 * the punch-matcher port.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";

export const drawRouter = router({
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
        message:
          "The start-draw engine is being re-ported against the new schema. Coming back online shortly.",
      });
    }),

  commit: eventProcedure
    .input(z.object({ entries: z.array(z.unknown()).optional() }))
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Draw commit pending re-port; see preview message.",
      });
    }),
});
