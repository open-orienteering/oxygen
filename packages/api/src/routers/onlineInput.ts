/**
 * Online-input (ROC / SICenter) router. Exposes config + enable /
 * disable + a manual `pollNow` to the EventPage panel; the actual
 * pull pipeline lives in `../online-input/puller.ts` and the API
 * boot calls `reconcileEnabledPullers()` so enabled events resume
 * polling after a restart without manual intervention.
 *
 * Config (persisted as JSON in `settings.online_input_<eventId>_config`):
 *   - `unitId`: ROC / SICenter station id (string, e.g. "12345")
 *   - `endpointUrl`: HTTP base URL
 *   - `intervalSeconds`: poll cadence (seconds)
 *   - `mapping`: `{ [rawCode: number]: 1 | 2 | 3 }` — raw control codes
 *     that should be re-mapped to special punches; the legacy targets
 *     are 1=start, 2=finish, 3=check.
 *   - `lastId`: highest punch id we've already consumed (so the puller
 *     can ask Eventor / ROC for "everything after this").
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";
import { getSetting, setSetting } from "../db.js";
import {
  setPullerEnabled,
  pollOnceForEvent,
} from "../online-input/puller.js";

type SpecialTarget = 1 | 2 | 3;

type OnlineInputConfig = {
  enabled: boolean;
  protocol: "roc" | "sicenter";
  unitId: string;
  endpointUrl: string;
  intervalSeconds: number;
  mapping: Record<number, SpecialTarget>;
  lastId: number;
};

const DEFAULT_CONFIG: OnlineInputConfig = {
  enabled: false,
  protocol: "roc",
  unitId: "",
  endpointUrl: "",
  intervalSeconds: 10,
  mapping: {},
  lastId: 0,
};

function settingKey(eventId: bigint, name: string) {
  return `online_input_${eventId.toString()}_${name}`;
}

async function loadConfig(eventId: bigint): Promise<OnlineInputConfig> {
  const raw = await getSetting(settingKey(eventId, "config"));
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<OnlineInputConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      // mapping needs an explicit clone so the in-memory edits don't
      // leak across requests via the JSON parser's default behaviour.
      mapping: { ...(parsed.mapping ?? {}) } as Record<number, SpecialTarget>,
    };
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
    const cfg = await loadConfig(ctx.event.id);
    const lastPolledRaw = await getSetting(
      settingKey(ctx.event.id, "last_polled"),
    );
    const pollCountRaw = await getSetting(
      settingKey(ctx.event.id, "poll_count"),
    );
    const importedRaw = await getSetting(
      settingKey(ctx.event.id, "punches_imported"),
    );
    const lastError = await getSetting(
      settingKey(ctx.event.id, "last_error"),
    );
    return {
      running: cfg.enabled,
      lastPoll: lastPolledRaw,
      pollCount: pollCountRaw ? parseInt(pollCountRaw, 10) : 0,
      punchesImported: importedRaw ? parseInt(importedRaw, 10) : 0,
      lastError: lastError && lastError.length > 0 ? lastError : null,
    };
  }),

  /**
   * Save the operator-editable subset of the config. `enabled` is
   * intentionally excluded — that goes through `enable` / `disable`
   * so the EventPage toggle is unambiguous.
   */
  saveConfig: eventProcedure
    .input(
      z.object({
        protocol: z.enum(["roc", "sicenter"]).optional(),
        unitId: z.string().optional(),
        endpointUrl: z.string().optional(),
        intervalSeconds: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await loadConfig(ctx.event.id);
      if (input.protocol !== undefined) cfg.protocol = input.protocol;
      if (input.unitId !== undefined) cfg.unitId = input.unitId;
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
      await setPullerEnabled(ctx.event.id, input.enabled);
      return { ok: true as const };
    }),

  enable: eventProcedure.mutation(async ({ ctx }) => {
    const cfg = await loadConfig(ctx.event.id);
    cfg.enabled = true;
    await saveLoadedConfig(ctx.event.id, cfg);
    await setPullerEnabled(ctx.event.id, true);
    return { ok: true as const };
  }),

  disable: eventProcedure.mutation(async ({ ctx }) => {
    const cfg = await loadConfig(ctx.event.id);
    cfg.enabled = false;
    await saveLoadedConfig(ctx.event.id, cfg);
    await setPullerEnabled(ctx.event.id, false);
    return { ok: true as const };
  }),

  /**
   * One-shot poll. Runs synchronously and returns whatever the puller
   * managed to ingest. The interval poller keeps running independently.
   */
  pollNow: eventProcedure.mutation(async ({ ctx }) => {
    const cfg = await loadConfig(ctx.event.id);
    if (!cfg.endpointUrl || !cfg.unitId) {
      return {
        ok: false as const,
        message: "Configure endpoint URL and unit id first.",
        stats: { fetched: 0, inserted: 0 },
      };
    }
    // Force-enable for the duration of the poll so a manual click works
    // before the operator has flipped the running toggle.
    const wasEnabled = cfg.enabled;
    if (!wasEnabled) {
      cfg.enabled = true;
      await saveLoadedConfig(ctx.event.id, cfg);
    }
    let stats = { fetched: 0, inserted: 0 };
    try {
      stats = await pollOnceForEvent(ctx.event.id);
    } finally {
      if (!wasEnabled) {
        const c = await loadConfig(ctx.event.id);
        c.enabled = false;
        await saveLoadedConfig(ctx.event.id, c);
      }
    }
    return { ok: true as const, message: "Poll complete.", stats };
  }),

  clearLastId: eventProcedure.mutation(async ({ ctx }) => {
    const cfg = await loadConfig(ctx.event.id);
    cfg.lastId = 0;
    await saveLoadedConfig(ctx.event.id, cfg);
    return { ok: true as const };
  }),

  /**
   * Add or update one raw-code → target mapping. `target` is one of
   * 1 (start), 2 (finish), 3 (check) — see legacy SPECIAL_PUNCH_OPTIONS
   * for the canonical names.
   */
  addMapping: eventProcedure
    .input(
      z.object({
        rawCode: z.number().int().positive(),
        target: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await loadConfig(ctx.event.id);
      cfg.mapping[input.rawCode] = input.target;
      await saveLoadedConfig(ctx.event.id, cfg);
      return { ok: true as const };
    }),

  removeMapping: eventProcedure
    .input(z.object({ rawCode: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await loadConfig(ctx.event.id);
      delete cfg.mapping[input.rawCode];
      await saveLoadedConfig(ctx.event.id, cfg);
      return { ok: true as const };
    }),
});
