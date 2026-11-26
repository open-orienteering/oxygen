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
 *     can ask ROC for "everything after this"). The puller moves it with
 *     a compare-and-set; every write here goes through `updateConfig`,
 *     which locks the row, so a save can never roll it back.
 */

import { z } from "zod";
import { router, raceOperateProcedure } from "../trpc.js";
import { prisma, getSetting } from "../db.js";
import { pollOnceForEvent } from "../online-input/puller.js";
import { requestBackgroundReconcile } from "../background/supervisor.js";

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
  return parseConfig(await getSetting(settingKey(eventId, "config")));
}

function parseConfig(raw: string | null): OnlineInputConfig {
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

/**
 * Read-modify-write the config row under a row lock.
 *
 * The puller moves `lastId` inside the same row with a compare-and-set
 * (`advanceWatermark` in `../online-input/puller.ts`). An unlocked
 * load-then-save that straddled a poll commit would write the older
 * `lastId` back, so the next poll would fetch and import that range a
 * second time. Holding `FOR UPDATE` serialises the two: the poll's
 * `UPDATE` waits for this transaction and then re-checks its condition
 * against the row as this one left it.
 */
async function updateConfig(
  eventId: bigint,
  mutate: (cfg: OnlineInputConfig) => void,
): Promise<OnlineInputConfig> {
  const key = settingKey(eventId, "config");
  return prisma().$transaction(async (tx) => {
    // Make sure there is a row to lock; a first save creates it.
    await tx.$executeRaw`
      INSERT INTO oxygen.settings (key, value)
      VALUES (${key}, ${JSON.stringify(DEFAULT_CONFIG)})
      ON CONFLICT (key) DO NOTHING
    `;
    const rows = await tx.$queryRaw<{ value: string | null }[]>`
      SELECT value FROM oxygen.settings WHERE key = ${key} FOR UPDATE
    `;
    const cfg = parseConfig(rows[0]?.value ?? null);
    mutate(cfg);
    await tx.setting.update({
      where: { key },
      data: { value: JSON.stringify(cfg) },
    });
    return cfg;
  });
}

export const onlineInputRouter = router({
  getConfig: raceOperateProcedure.query(async ({ ctx }) => loadConfig(ctx.event.id)),

  getStatus: raceOperateProcedure.query(async ({ ctx }) => {
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
  saveConfig: raceOperateProcedure
    .input(
      z.object({
        protocol: z.enum(["roc", "sicenter"]).optional(),
        unitId: z.string().optional(),
        endpointUrl: z.string().optional(),
        intervalSeconds: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateConfig(ctx.event.id, (cfg) => {
        if (input.protocol !== undefined) cfg.protocol = input.protocol;
        if (input.unitId !== undefined) cfg.unitId = input.unitId;
        if (input.endpointUrl !== undefined) cfg.endpointUrl = input.endpointUrl;
        if (input.intervalSeconds !== undefined)
          cfg.intervalSeconds = input.intervalSeconds;
      });
      return { ok: true as const };
    }),

  setConfig: raceOperateProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        protocol: z.enum(["roc", "sicenter"]).default("roc"),
        url: z.string().url().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateConfig(ctx.event.id, (cfg) => {
        cfg.enabled = input.enabled;
        cfg.protocol = input.protocol;
        if (input.url) cfg.endpointUrl = input.url;
      });
      await requestBackgroundReconcile();
      return { ok: true as const };
    }),

  enable: raceOperateProcedure.mutation(async ({ ctx }) => {
    await updateConfig(ctx.event.id, (cfg) => {
      cfg.enabled = true;
    });
    await requestBackgroundReconcile();
    return { ok: true as const };
  }),

  disable: raceOperateProcedure.mutation(async ({ ctx }) => {
    await updateConfig(ctx.event.id, (cfg) => {
      cfg.enabled = false;
    });
    await requestBackgroundReconcile();
    return { ok: true as const };
  }),

  /**
   * One-shot poll. Runs synchronously and returns whatever the puller
   * managed to ingest. The interval poller keeps running independently.
   */
  pollNow: raceOperateProcedure.mutation(async ({ ctx }) => {
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
      await updateConfig(ctx.event.id, (c) => {
        c.enabled = true;
      });
    }
    let stats = { fetched: 0, inserted: 0 };
    try {
      stats = await pollOnceForEvent(ctx.event.id);
    } finally {
      if (!wasEnabled) {
        await updateConfig(ctx.event.id, (c) => {
          c.enabled = false;
        });
      }
    }
    return { ok: true as const, message: "Poll complete.", stats };
  }),

  /**
   * Reset the watermark so the next poll asks ROC for every punch again.
   * Safe mid-event: punches already stored are skipped by the puller's
   * conflict-skipping insert, so only the missing ones are added.
   */
  clearLastId: raceOperateProcedure.mutation(async ({ ctx }) => {
    await updateConfig(ctx.event.id, (cfg) => {
      cfg.lastId = 0;
    });
    return { ok: true as const };
  }),

  /**
   * Add or update one raw-code → target mapping. `target` is one of
   * 1 (start), 2 (finish), 3 (check) — see legacy SPECIAL_PUNCH_OPTIONS
   * for the canonical names.
   */
  addMapping: raceOperateProcedure
    .input(
      z.object({
        rawCode: z.number().int().positive(),
        target: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateConfig(ctx.event.id, (cfg) => {
        cfg.mapping[input.rawCode] = input.target;
      });
      return { ok: true as const };
    }),

  removeMapping: raceOperateProcedure
    .input(z.object({ rawCode: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await updateConfig(ctx.event.id, (cfg) => {
        delete cfg.mapping[input.rawCode];
      });
      return { ok: true as const };
    }),
});
