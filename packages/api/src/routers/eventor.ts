/**
 * Eventor sync router — config + minimal API key handling. The full sync
 * pipeline (event import, entries import, runner DB / club DB sync,
 * results push) is being re-ported against the new schema. Stubs throw a
 * clear PRECONDITION_FAILED so UI buttons can fail gracefully until then.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, eventProcedure } from "../trpc.js";
import { getSetting, setSetting } from "../db.js";

const notReady = (op: string): never => {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `Eventor ${op} is being re-ported against the new schema. Coming back online shortly.`,
  });
};

export const eventorRouter = router({
  /** Get the current Eventor API key for an environment. */
  getKey: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .query(async ({ input }) => {
      const key =
        input.env === "test" ? "eventor_api_key_test" : "eventor_api_key";
      const value = await getSetting(key);
      return { hasKey: !!value, env: input.env };
    }),

  /** Replace the stored Eventor API key. */
  setKey: publicProcedure
    .input(
      z.object({
        env: z.enum(["prod", "test"]).default("prod"),
        apiKey: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const key =
        input.env === "test" ? "eventor_api_key_test" : "eventor_api_key";
      await setSetting(key, input.apiKey);
      return { ok: true as const };
    }),

  /** Clear the stored API key for one environment. */
  clearKey: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .mutation(async ({ input }) => {
      const key =
        input.env === "test" ? "eventor_api_key_test" : "eventor_api_key";
      await setSetting(key, null);
      return { ok: true as const };
    }),

  /** Validate a candidate key by hitting Eventor's identity endpoint. */
  validateKey: publicProcedure
    .input(z.object({ apiKey: z.string().min(1), env: z.enum(["prod", "test"]).default("prod") }))
    .mutation(async () => {
      return notReady("API key validation");
    }),

  /** Set the per-event Eventor environment. */
  setEventEnv: eventProcedure
    .input(z.object({ env: z.enum(["prod", "test"]) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.event.update({
        where: { id: ctx.event.id },
        data: { eventorEnv: input.env },
      });
      return { ok: true as const };
    }),

  // The remaining endpoints are stubs until the sync pipeline lands.
  searchEvents: publicProcedure
    .input(z.object({ query: z.string() }))
    .query(async () => {
      return [] as Array<{ id: number; name: string; startDate: string }>;
    }),

  importEvent: eventProcedure
    .input(z.object({ eventorEventId: z.number().int() }))
    .mutation(async () => notReady("event import")),

  importEntries: eventProcedure.mutation(async () => notReady("entry import")),

  syncRunnerDb: publicProcedure.mutation(async () => notReady("runner DB sync")),

  runnerDbStatus: publicProcedure.query(async () => {
    const last = await getSetting("runnerdb_last_sync");
    const runners = await getSetting("runnerdb_runner_count");
    const clubs = await getSetting("runnerdb_club_count");
    return {
      lastSync: last,
      runnerCount: runners ? Number(runners) : 0,
      clubCount: clubs ? Number(clubs) : 0,
    };
  }),

  pushResults: eventProcedure.mutation(async () => notReady("results push")),

  pushStartList: eventProcedure.mutation(async () => notReady("start-list push")),
});
