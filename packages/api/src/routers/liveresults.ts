/**
 * LiveResults router — config endpoints only. The push pipeline that
 * pumps start lists / results to liveresultat.orientering.se is being
 * re-ported against the new schema as a follow-up.
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";

export const liveresultsRouter = router({
  getConfig: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    return {
      tavid: event?.liveresultsTavid ?? null,
      config: event?.liveresultsConfig ?? null,
    };
  }),

  setConfig: eventProcedure
    .input(
      z.object({
        tavid: z.number().int().nullable().optional(),
        config: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data: Record<string, unknown> = {};
      if (input.tavid !== undefined) data.liveresultsTavid = input.tavid;
      if (input.config !== undefined) data.liveresultsConfig = input.config;
      if (Object.keys(data).length > 0) {
        await ctx.db.event.update({
          where: { id: ctx.event.id },
          data,
        });
      }
      return { ok: true as const };
    }),
});
