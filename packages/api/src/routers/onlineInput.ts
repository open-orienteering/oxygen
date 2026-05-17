/**
 * Online-input (ROC / SICenter) router. The puller itself is being
 * re-ported against the new schema; for now we persist config as JSON
 * inside the events row (under `liveresultsConfig` — repurposed key, to
 * avoid adding a new column for a soon-to-be-rewritten feature). The
 * routes return enough shape for the EventPage panel to render.
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";
import { getSetting, setSetting } from "../db.js";

type OnlineInputConfig = {
  enabled: boolean;
  protocol: "roc" | "sicenter";
  endpointUrl: string;
  intervalSeconds: number;
  mapping: Array<{ controlCode: number; punchCode: number }>;
};

const DEFAULT_CONFIG: OnlineInputConfig = {
  enabled: false,
  protocol: "roc",
  endpointUrl: "",
  intervalSeconds: 30,
  mapping: [],
};

function settingKey(eventId: bigint, name: string) {
  return `online_input_${eventId.toString()}_${name}`;
}

async function loadConfig(eventId: bigint): Promise<OnlineInputConfig> {
  const raw = await getSetting(settingKey(eventId, "config"));
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<OnlineInputConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveLoadedConfig(eventId: bigint, cfg: OnlineInputConfig) {
  await setSetting(settingKey(eventId, "config"), JSON.stringify(cfg));
}

export const onlineInputRouter = router({
  getConfig: eventProcedure.query(async ({ ctx }) => loadConfig(ctx.event.id)),

  getStatus: eventProcedure.query(async ({ ctx }) => {
    const lastIdRaw = await getSetting(settingKey(ctx.event.id, "last_id"));
    const lastPolledRaw = await getSetting(settingKey(ctx.event.id, "last_polled"));
    return {
      running: false,
      lastId: lastIdRaw ? parseInt(lastIdRaw, 10) : 0,
      lastPolledAt: lastPolledRaw,
      lastError: null as string | null,
      processed: 0,
    };
  }),

  saveConfig: eventProcedure
    .input(
      z.object({
        protocol: z.enum(["roc", "sicenter"]).optional(),
        endpointUrl: z.string().optional(),
        intervalSeconds: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await loadConfig(ctx.event.id);
      if (input.protocol !== undefined) cfg.protocol = input.protocol;
      if (input.endpointUrl !== undefined) cfg.endpointUrl = input.endpointUrl;
      if (input.intervalSeconds !== undefined)
        cfg.intervalSeconds = input.intervalSeconds;
      await saveLoadedConfig(ctx.event.id, cfg);
      return { ok: true as const };
    }),

  setConfig: eventProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        protocol: z.enum(["roc", "sicenter"]).default("roc"),
        url: z.string().url().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await loadConfig(ctx.event.id);
      cfg.enabled = input.enabled;
      cfg.protocol = input.protocol;
      if (input.url) cfg.endpointUrl = input.url;
      await saveLoadedConfig(ctx.event.id, cfg);
      return { ok: true as const };
    }),

  enable: eventProcedure.mutation(async ({ ctx }) => {
    const cfg = await loadConfig(ctx.event.id);
    cfg.enabled = true;
    await saveLoadedConfig(ctx.event.id, cfg);
    return { ok: true as const };
  }),

  disable: eventProcedure.mutation(async ({ ctx }) => {
    const cfg = await loadConfig(ctx.event.id);
    cfg.enabled = false;
    await saveLoadedConfig(ctx.event.id, cfg);
    return { ok: true as const };
  }),

  pollNow: eventProcedure.mutation(async () => ({
    ok: true as const,
    message: "Online-input puller pending re-port.",
  })),

  clearLastId: eventProcedure.mutation(async ({ ctx }) => {
    await setSetting(settingKey(ctx.event.id, "last_id"), null);
    return { ok: true as const };
  }),

  addMapping: eventProcedure
    .input(z.object({ controlCode: z.number().int(), punchCode: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await loadConfig(ctx.event.id);
      cfg.mapping = cfg.mapping.filter((m) => m.controlCode !== input.controlCode);
      cfg.mapping.push({ controlCode: input.controlCode, punchCode: input.punchCode });
      await saveLoadedConfig(ctx.event.id, cfg);
      return { ok: true as const };
    }),

  removeMapping: eventProcedure
    .input(z.object({ controlCode: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await loadConfig(ctx.event.id);
      cfg.mapping = cfg.mapping.filter((m) => m.controlCode !== input.controlCode);
      await saveLoadedConfig(ctx.event.id, cfg);
      return { ok: true as const };
    }),
});
