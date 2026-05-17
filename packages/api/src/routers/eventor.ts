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

  // ─── Surface used by EventPage / RegistrationDialog ─────

  /** Aggregated sync status for the active event. */
  syncStatus: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { eventorEventId: true, eventorEnv: true },
    });
    return {
      linked: !!event?.eventorEventId,
      eventorEventId: event?.eventorEventId ? Number(event.eventorEventId) : 0,
      env: event?.eventorEnv ?? "prod",
      lastSync: null as string | null,
      runnerCount: 0,
      classCount: 0,
    };
  }),

  /** Top-level sync trigger (placeholder). */
  sync: eventProcedure.mutation(async () => notReady("event sync")),

  /** Refresh club roster from Eventor (placeholder). */
  syncClubs: eventProcedure.mutation(async () => notReady("club sync")),

  /** Is the configured API key valid (cached check, no live call yet)? */
  keyStatus: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .query(async ({ input }) => {
      const key = input.env === "test" ? "eventor_api_key_test" : "eventor_api_key";
      const value = await getSetting(key);
      return {
        hasKey: !!value,
        env: input.env,
        valid: !!value, // optimistic — actual validate call pending re-port
      };
    }),

  /** Search the global runner directory by partial name / id. */
  searchRunnerDb: publicProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      void ctx;
      const { prisma } = await import("../db.js");
      const rows = await prisma().runnerDirectory.findMany({
        where: { name: { contains: input.query, mode: "insensitive" } },
        take: 30,
      });
      return rows.map((r) => ({
        eventorPersonId: Number(r.eventorPersonId),
        name: r.name,
        cardNo: r.cardNo,
        eventorClubId: r.eventorClubId,
        birthYear: r.birthYear,
        sex: r.sex,
      }));
    }),

  /** Look up a single runner in the global directory by SI card number. */
  lookupByCardNo: publicProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ input }) => {
      const { prisma } = await import("../db.js");
      const r = await prisma().runnerDirectory.findFirst({
        where: { cardNo: input.cardNo },
      });
      if (!r) return null;
      return {
        eventorPersonId: Number(r.eventorPersonId),
        name: r.name,
        cardNo: r.cardNo,
        eventorClubId: r.eventorClubId,
        birthYear: r.birthYear,
        sex: r.sex,
      };
    }),

  /** All runner-directory rows for a given Eventor club. */
  clubMembers: publicProcedure
    .input(z.object({ eventorClubId: z.number().int() }))
    .query(async ({ input }) => {
      const { prisma } = await import("../db.js");
      const rows = await prisma().runnerDirectory.findMany({
        where: { eventorClubId: input.eventorClubId },
        orderBy: { name: "asc" },
      });
      return rows.map((r) => ({
        eventorPersonId: Number(r.eventorPersonId),
        name: r.name,
        cardNo: r.cardNo,
        birthYear: r.birthYear,
        sex: r.sex,
      }));
    }),

  /** Dump the full directory (used by RegistrationDialog client-side search). */
  runnerDbDump: publicProcedure.query(async () => {
    const { prisma } = await import("../db.js");
    const rows = await prisma().runnerDirectory.findMany({
      orderBy: { name: "asc" },
      take: 50_000,
    });
    return rows.map((r) => ({
      eventorPersonId: Number(r.eventorPersonId),
      name: r.name,
      cardNo: r.cardNo,
      eventorClubId: r.eventorClubId,
      birthYear: r.birthYear,
      sex: r.sex,
    }));
  }),

  /** Eventor-side classes for the given event (placeholder). */
  getLiveloxClasses: publicProcedure
    .input(z.object({ eventorEventId: z.number().int() }))
    .query(async () => {
      return [] as Array<{ id: number; name: string }>;
    }),
});
