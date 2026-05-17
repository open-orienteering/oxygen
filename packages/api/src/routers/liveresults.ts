/**
 * LiveResults router. The push pipeline that pumps start lists / results
 * to liveresultat.orientering.se is being re-ported against the new
 * schema; this router exposes config + status surface so the EventPage
 * panel can render and offer the basic toggles.
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";

export const liveresultsRouter = router({
  getConfig: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    const cfg = (event?.liveresultsConfig as Record<string, unknown>) ?? {};
    return {
      tavid: event?.liveresultsTavid ?? null,
      enabled: cfg.enabled === true,
      autoPush: cfg.autoPush === true,
      publicUrl: cfg.publicUrl ?? "",
      config: event?.liveresultsConfig ?? null,
    };
  }),

  getStatus: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    const cfg = (event?.liveresultsConfig as Record<string, unknown>) ?? {};
    return {
      enabled: cfg.enabled === true,
      tavid: event?.liveresultsTavid ?? null,
      lastPushAt: null as string | null,
      lastError: null as string | null,
      runnersPushed: 0,
    };
  }),

  saveConfig: eventProcedure
    .input(
      z.object({
        tavid: z.number().int().nullable().optional(),
        autoPush: z.boolean().optional(),
        publicUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: { liveresultsConfig: true },
      });
      const cfg = (existing?.liveresultsConfig as Record<string, unknown>) ?? {};
      if (input.autoPush !== undefined) cfg.autoPush = input.autoPush;
      if (input.publicUrl !== undefined) cfg.publicUrl = input.publicUrl;
      const data: Record<string, unknown> = { liveresultsConfig: cfg as never };
      if (input.tavid !== undefined) data.liveresultsTavid = input.tavid;
      await ctx.db.event.update({ where: { id: ctx.event.id }, data });
      return { ok: true as const };
    }),

  enable: eventProcedure.mutation(async ({ ctx }) => {
    const existing = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsConfig: true },
    });
    const cfg = (existing?.liveresultsConfig as Record<string, unknown>) ?? {};
    cfg.enabled = true;
    await ctx.db.event.update({
      where: { id: ctx.event.id },
      data: { liveresultsConfig: cfg as never },
    });
    return { ok: true as const };
  }),

  disable: eventProcedure.mutation(async ({ ctx }) => {
    const existing = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsConfig: true },
    });
    const cfg = (existing?.liveresultsConfig as Record<string, unknown>) ?? {};
    cfg.enabled = false;
    await ctx.db.event.update({
      where: { id: ctx.event.id },
      data: { liveresultsConfig: cfg as never },
    });
    return { ok: true as const };
  }),

  pushNow: eventProcedure.mutation(async () => ({
    ok: true as const,
    message: "LiveResults push pipeline pending re-port.",
  })),

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
