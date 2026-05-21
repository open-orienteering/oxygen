/**
 * LiveResults router. The push pipeline that pumps start lists / results
 * to liveresultat.orientering.se is being re-ported against the new
 * schema; this router exposes the config + status surface so the
 * EventPage panel can render, take the user's settings, and show the
 * live indicator. The actual periodic push is a no-op for now.
 *
 * Settings live in `events.liveresultsConfig` (JSONB) so we don't need
 * a per-event settings table: the shape mirrors what the legacy MeOS
 * router exposed, which keeps `EventPage` unchanged.
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";

export interface LRConfig {
  enabled: boolean;
  tavid: number | null;
  intervalSeconds: number;
  country: string;
  isPublic: boolean;
  publicUrl: string;
}

const DEFAULT_CFG: LRConfig = {
  enabled: false,
  tavid: null,
  intervalSeconds: 30,
  country: "SE",
  isPublic: false,
  publicUrl: "",
};

function readConfig(
  jsonb: unknown,
  tavidColumn: number | null,
): LRConfig {
  const j = (jsonb ?? {}) as Partial<LRConfig>;
  return {
    enabled: j.enabled === true,
    tavid: tavidColumn ?? j.tavid ?? null,
    intervalSeconds:
      typeof j.intervalSeconds === "number"
        ? j.intervalSeconds
        : DEFAULT_CFG.intervalSeconds,
    country: typeof j.country === "string" ? j.country : DEFAULT_CFG.country,
    isPublic: j.isPublic === true,
    publicUrl: typeof j.publicUrl === "string" ? j.publicUrl : "",
  };
}

export const liveresultsRouter = router({
  getConfig: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    return readConfig(event?.liveresultsConfig, event?.liveresultsTavid ?? null);
  }),

  /**
   * Live snapshot for the status indicator.
   *
   * `running` mirrors `config.enabled` until the actual push worker
   * lands — once it does, this turns into a real "did we push within
   * the last N seconds" check.
   */
  getStatus: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    const cfg = readConfig(event?.liveresultsConfig, event?.liveresultsTavid ?? null);
    return {
      running: cfg.enabled,
      tavid: cfg.tavid,
      publicUrl: cfg.publicUrl,
      lastPush: null as string | null,
      pushCount: 0,
      lastError: null as string | null,
    };
  }),

  /**
   * Save the operator-editable subset of the config.
   *
   * We deliberately don't include `enabled` here — toggling that goes
   * through `enable` / `disable` so the EventPage UI can render an
   * unambiguous toggle that only flips the boolean.
   */
  saveConfig: eventProcedure
    .input(
      z.object({
        intervalSeconds: z.number().int().min(5).max(3600).optional(),
        country: z.string().max(8).optional(),
        isPublic: z.boolean().optional(),
        tavid: z.number().int().nullable().optional(),
        publicUrl: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: { liveresultsTavid: true, liveresultsConfig: true },
      });
      const cfg = readConfig(
        existing?.liveresultsConfig,
        existing?.liveresultsTavid ?? null,
      );
      if (input.intervalSeconds !== undefined)
        cfg.intervalSeconds = input.intervalSeconds;
      if (input.country !== undefined) cfg.country = input.country;
      if (input.isPublic !== undefined) cfg.isPublic = input.isPublic;
      if (input.publicUrl !== undefined) cfg.publicUrl = input.publicUrl;
      const data: Record<string, unknown> = { liveresultsConfig: cfg as never };
      if (input.tavid !== undefined) data.liveresultsTavid = input.tavid;
      await ctx.db.event.update({ where: { id: ctx.event.id }, data });
      return { ok: true as const };
    }),

  enable: eventProcedure.mutation(async ({ ctx }) => {
    const existing = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    const cfg = readConfig(
      existing?.liveresultsConfig,
      existing?.liveresultsTavid ?? null,
    );
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
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    const cfg = readConfig(
      existing?.liveresultsConfig,
      existing?.liveresultsTavid ?? null,
    );
    cfg.enabled = false;
    await ctx.db.event.update({
      where: { id: ctx.event.id },
      data: { liveresultsConfig: cfg as never },
    });
    return { ok: true as const };
  }),

  /**
   * Manual one-shot push. Stubbed until the pump is re-ported, but we
   * return a realistic `stats: { runners, results, splitcontrols }` so
   * the EventPage status line renders the right shape.
   */
  pushNow: eventProcedure.mutation(async () => ({
    ok: true as const,
    message: "LiveResults push pipeline pending re-port.",
    stats: { runners: 0, results: 0, splitcontrols: 0 },
  })),

  /**
   * Legacy alias kept for internal tooling that wants to write the raw
   * JSON blob (e.g. tests that bypass `saveConfig`). EventPage doesn't
   * call it; flag it as a thin pass-through.
   */
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
        await ctx.db.event.update({ where: { id: ctx.event.id }, data });
      }
      return { ok: true as const };
    }),
});
