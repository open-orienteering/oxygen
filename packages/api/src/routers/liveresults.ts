/**
 * LiveResults router. Exposes the config + manual sync + status surface
 * to the EventPage; the actual periodic push is owned by
 * `liveResultsPusherManager` in `../liveresults.ts`, which the API
 * boot wires through `reconcileEnabledPushers()` so a restart re-arms
 * every event whose `liveresultsConfig.enabled` is true.
 *
 * Settings live in `events.liveresultsConfig` (JSONB) so we don't need
 * a per-event settings table.
 */

import { z } from "zod";
import { router, viewProcedure, manageProcedure } from "../trpc.js";
import {
  ensureCompetition,
  liveResultsPusherManager,
  syncAll,
  updateCompetitionMeta,
} from "../liveresults.js";

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
  getConfig: viewProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    return readConfig(event?.liveresultsConfig, event?.liveresultsTavid ?? null);
  }),

  /**
   * Live snapshot for the status indicator. `running` reflects whether
   * the in-process push timer is currently armed for this event (not
   * just whether `config.enabled` is true) — that distinction matters
   * during boot-time reconciliation and after a failed `enable`.
   */
  getStatus: viewProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true, liveresultsConfig: true },
    });
    const cfg = readConfig(
      event?.liveresultsConfig,
      event?.liveresultsTavid ?? null,
    );
    const status = liveResultsPusherManager.getStatus(ctx.event.id);
    return {
      running: status.running,
      tavid: cfg.tavid,
      publicUrl: cfg.publicUrl,
      lastPush: status.lastPush,
      pushCount: status.pushCount,
      lastError: status.lastError,
    };
  }),

  /**
   * Save the operator-editable subset of the config.
   *
   * We deliberately don't include `enabled` here — toggling that goes
   * through `enable` / `disable` so the EventPage UI can render an
   * unambiguous toggle that only flips the boolean.
   */
  saveConfig: manageProcedure
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

  enable: manageProcedure.mutation(async ({ ctx }) => {
    const existing = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: {
        liveresultsTavid: true,
        liveresultsConfig: true,
        name: true,
        organizerName: true,
      },
    });
    const cfg = readConfig(
      existing?.liveresultsConfig,
      existing?.liveresultsTavid ?? null,
    );

    // Allocate a tavid lazily on first enable so the operator never
    // has to know what it is. ensureCompetition is idempotent.
    const tavid = await ensureCompetition(ctx.event.id);
    cfg.tavid = tavid;
    cfg.enabled = true;
    await ctx.db.event.update({
      where: { id: ctx.event.id },
      data: { liveresultsConfig: cfg as never, liveresultsTavid: tavid },
    });

    // Keep the remote `login` row in sync with the latest event name +
    // organizer + public flag before the timer starts pushing
    // splitcontrols/results into it.
    try {
      await updateCompetitionMeta(tavid, {
        compName: existing?.name,
        organizer: existing?.organizerName ?? "",
        isPublic: cfg.isPublic,
        country: cfg.country,
      });
    } catch (err) {
      console.error("[LiveResults] updateCompetitionMeta failed:", err);
    }

    liveResultsPusherManager.start(ctx.event.id, tavid, cfg.intervalSeconds);
    return { ok: true as const, tavid };
  }),

  disable: manageProcedure.mutation(async ({ ctx }) => {
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
    liveResultsPusherManager.stop(ctx.event.id);
    return { ok: true as const };
  }),

  /**
   * Manual one-shot push. Bypasses the interval timer entirely so the
   * operator can verify connectivity / data shape on demand. Returns
   * the same `{ runners, results, splitcontrols }` shape the timer
   * exposes via status.
   */
  pushNow: manageProcedure.mutation(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { liveresultsTavid: true },
    });
    let tavid = event?.liveresultsTavid ?? null;
    if (!tavid) {
      tavid = await ensureCompetition(ctx.event.id);
    }
    const stats = await syncAll(tavid, ctx.event.id);
    return {
      ok: true as const,
      message: "LiveResults push complete.",
      stats,
    };
  }),

  /**
   * Legacy alias kept for internal tooling that wants to write the raw
   * JSON blob (e.g. tests that bypass `saveConfig`). EventPage doesn't
   * call it; flag it as a thin pass-through.
   */
  setConfig: manageProcedure
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
