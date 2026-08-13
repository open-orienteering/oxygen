import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure, publicProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import { WITHDRAWN_STATUSES, type ClubSummary, type ClubDetail } from "@oxygen/shared";
import { valueToRunnerStatus } from "../statusConvert.js";

const withdrawnEnums = WITHDRAWN_STATUSES.map(valueToRunnerStatus);

/**
 * Clubs are not first-class entities anymore (Phase I refactor). This
 * router derives the club roster from the runner table + the global
 * club_directory cache. Filters / drill-down accept eventor_id (positive)
 * or a clubName when no eventor id exists.
 */
export const clubRouter = router({
  /** Aggregate clubs from the active event's runner roster.
   *  `showAll` includes clubs without participating runners (currently
   *  identical because clubs aren't first-class entities anymore). */
  list: eventProcedure
    .input(z.object({ showAll: z.boolean().optional() }).optional())
    .query(async ({ ctx }): Promise<ClubSummary[]> => {
    const runners = await ctx.db.runner.findMany({
      where: {
        eventId: ctx.event.id,
        removed: false,
        status: { notIn: withdrawnEnums },
      },
      select: { clubName: true, eventorClubId: true },
    });
    // Group by eventor_club_id when set, else by lowercased club_name.
    const byEventor = new Map<bigint, { name: string; count: number }>();
    const byName = new Map<string, { name: string; count: number }>();
    for (const r of runners) {
      if (r.eventorClubId) {
        const cur = byEventor.get(r.eventorClubId);
        if (cur) cur.count++;
        else
          byEventor.set(r.eventorClubId, {
            name: r.clubName,
            count: 1,
          });
      } else if (r.clubName) {
        const k = r.clubName.toLowerCase();
        const cur = byName.get(k);
        if (cur) cur.count++;
        else byName.set(k, { name: r.clubName, count: 1 });
      }
    }
    const eventorIds = [...byEventor.keys()];
    const dirRows = eventorIds.length
      ? await ctx.db.clubDirectory.findMany({
          where: { eventorId: { in: eventorIds } },
        })
      : [];
    const dir = new Map(dirRows.map((d) => [d.eventorId, d]));

    const result: ClubSummary[] = [];
    for (const [eventorId, info] of byEventor) {
      const d = dir.get(eventorId);
      result.push({
        id: Number(eventorId),
        name: d?.name || info.name,
        shortName: d?.shortName ?? "",
        runnerCount: info.count,
        extId: Number(eventorId),
      });
    }
    for (const [k, info] of byName) {
      result.push({
        id: 0,
        name: info.name,
        shortName: "",
        runnerCount: info.count,
        extId: 0,
      });
      void k;
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }),

  /**
   * Legacy alias for `getById` — clubs are now keyed by Eventor id +
   * name rather than a per-event integer. The ClubsPage still calls
   * `detail({ id })` so we accept a numeric id and route it through.
   */
  detail: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }): Promise<ClubDetail> => {
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
      };
      if (input.id > 0) where.eventorClubId = input.id;
      const runners = await ctx.db.runner.findMany({
        where,
        include: { class: { select: { name: true } } },
      });
      let dir = null;
      if (input.id > 0) {
        dir = await ctx.db.clubDirectory.findUnique({
          where: { eventorId: BigInt(input.id) },
        });
      }
      const display = dir?.name || runners[0]?.clubName || "";
      return {
        id: input.id,
        name: display,
        shortName: dir?.shortName ?? "",
        district: 0,
        nationality: "",
        country: dir?.countryCode ?? "",
        careOf: "",
        street: "",
        city: "",
        zip: "",
        email: "",
        phone: "",
        extId: input.id,
        runners: runners.map((r) => ({
          id: r.seq,
          name: r.name,
          className: r.class?.name ?? "",
          cardNo: r.cardNo ?? 0,
        })),
      };
    }),

  /**
   * Read-only stubs. Clubs are now a global, Eventor-synced entity
   * (clubDirectory). Per-event create / edit / delete don't exist in
   * the new model — the ClubsPage UI surfaces these as disabled
   * operations and the API rejects them clearly.
   */
  create: eventProcedure
    .input(z.unknown())
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Clubs are now global. Add via Eventor sync (eventor.syncClubs) instead.",
      });
    }),

  update: eventProcedure
    .input(z.unknown())
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Clubs are now global. Edit the club_directory row via Eventor sync.",
      });
    }),

  delete: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Clubs are now global. Unassign runners from the club instead.",
      });
    }),

  /** Detail for a club identified by eventor_id (or 0 + name for free-text). */
  getById: eventProcedure
    .input(
      z.object({
        eventorId: z.number().int().optional(),
        name: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<ClubDetail> => {
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
      };
      if (input.eventorId && input.eventorId > 0) {
        where.eventorClubId = input.eventorId;
      } else if (input.name) {
        where.clubName = input.name;
      }
      const runners = await ctx.db.runner.findMany({
        where,
        include: { class: { select: { name: true } } },
      });
      let dir = null;
      if (input.eventorId && input.eventorId > 0) {
        dir = await ctx.db.clubDirectory.findUnique({
          where: { eventorId: BigInt(input.eventorId) },
        });
      }
      const display = dir?.name || runners[0]?.clubName || "";
      return {
        id: input.eventorId ?? 0,
        name: display,
        shortName: dir?.shortName ?? "",
        district: 0,
        nationality: "",
        country: dir?.countryCode ?? "",
        careOf: "",
        street: "",
        city: "",
        zip: "",
        email: "",
        phone: "",
        extId: input.eventorId ?? 0,
        runners: runners.map((r) => ({
          id: r.seq,
          name: r.name,
          className: r.class?.name ?? "",
          cardNo: r.cardNo ?? 0,
        })),
      };
    }),

  /**
   * Search the global club directory by name.
   * Returns matching clubs with their Eventor ids.
   */
  searchDirectory: publicProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const rows = await prisma().clubDirectory.findMany({
        where: {
          name: { contains: input.query, mode: "insensitive" },
        },
        take: 30,
      });
      return rows.map((d) => ({
        eventorId: Number(d.eventorId),
        name: d.name,
        shortName: d.shortName,
        countryCode: d.countryCode,
      }));
    }),

  /**
   * Map of club id (eventor_club_id) → Eventor organisation id. Since
   * clubs are now keyed by their Eventor id, this is an identity map
   * for every club that *has* a directory entry with a logo (so the
   * caller knows which logos to load).
   */
  logoMap: eventProcedure.query(async ({ ctx }) => {
    const runners = await ctx.db.runner.findMany({
      where: { eventId: ctx.event.id, removed: false },
      select: { eventorClubId: true },
    });
    const ids = [
      ...new Set(
        runners
          .map((r) => r.eventorClubId)
          .filter((id): id is bigint => id !== null),
      ),
    ];
    const dirs = ids.length
      ? await ctx.db.clubDirectory.findMany({
          where: { eventorId: { in: ids } },
          select: { eventorId: true, smallLogoPng: true },
        })
      : [];
    const map: Record<string, number> = {};
    for (const d of dirs) {
      if (d.smallLogoPng && d.smallLogoPng.length > 0) {
        map[d.eventorId.toString()] = Number(d.eventorId);
      }
    }
    return map;
  }),
});
