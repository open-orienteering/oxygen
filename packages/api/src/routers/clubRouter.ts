import { z } from "zod";
import { router, competitionProcedure } from "../trpc.js";
import {ensureLogoTable, getMainDbConnection, ensureClubDbTable} from "../db.js";
import type { ClubSummary, ClubDetail } from "@oxygen/shared";

export const clubRouter = router({
  /**
   * List all clubs with runner counts.
   */
  list: competitionProcedure
    .input(
      z
        .object({
          search: z.string().optional(),
          showAll: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }): Promise<ClubSummary[]> => {
      const client = ctx.db;

      const clubs = await client.oClub.findMany({
        where: { Removed: false },
        orderBy: { Name: "asc" },
      });

      // Count runners per club
      const runners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { Club: true },
      });

      const runnerCounts = new Map<number, number>();
      for (const r of runners) {
        runnerCounts.set(r.Club, (runnerCounts.get(r.Club) ?? 0) + 1);
      }

      let result = clubs.map(
        (c): ClubSummary => ({
          id: c.Id,
          name: c.Name,
          shortName: c.ShortName,
          runnerCount: runnerCounts.get(c.Id) ?? 0,
          extId: Number(c.ExtId),
        }),
      );

      // By default, only show clubs with at least one runner
      if (!input?.showAll) {
        result = result.filter((c) => c.runnerCount > 0);
      }

      if (input?.search) {
        const term = input.search.toLowerCase();
        result = result.filter(
          (c) =>
            c.name.toLowerCase().includes(term) ||
            c.shortName.toLowerCase().includes(term) ||
            String(c.id).includes(term),
        );
      }

      return result;
    }),

  /**
   * Get a single club with details and runner list.
   */
  detail: competitionProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }): Promise<ClubDetail | null> => {
      const client = ctx.db;

      const club = await client.oClub.findFirst({
        where: { Id: input.id, Removed: false },
      });
      if (!club) return null;

      const runners = await client.oRunner.findMany({
        where: { Club: input.id, Removed: false },
        orderBy: { Name: "asc" },
      });

      // Get class names
      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true },
      });
      const classMap = new Map(classes.map((c) => [c.Id, c.Name]));

      return {
        id: club.Id,
        name: club.Name,
        shortName: club.ShortName,
        district: club.District,
        nationality: club.Nationality,
        country: club.Country,
        careOf: club.CareOf,
        street: club.Street,
        city: club.City,
        zip: club.ZIP,
        email: club.EMail,
        phone: club.Phone,
        extId: Number(club.ExtId),
        runners: runners.map((r) => ({
          id: r.Id,
          name: r.Name,
          className: classMap.get(r.Class) ?? "",
          cardNo: r.CardNo,
        })),
      };
    }),

  /**
   * Create a new club.
   */
  create: competitionProcedure
    .input(
      z.object({
        name: z.string().min(1),
        shortName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const created = await client.oClub.create({
        data: {
          Name: input.name,
          ShortName: (input.shortName || input.name).substring(0, 17),
        },
      });
      return { id: created.Id };
    }),

  /**
   * Update a club.
   */
  update: competitionProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        shortName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.Name = input.name;
      if (input.shortName !== undefined)
        data.ShortName = input.shortName.substring(0, 17);

      await client.oClub.update({
        where: { Id: input.id },
        data,
      });
      return { success: true };
    }),

  /**
   * Delete a club (soft delete).
   */
  delete: competitionProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await client.oClub.update({
        where: { Id: input.id },
        data: { Removed: true },
      });
      return { success: true };
    }),

  /**
   * Return a mapping of local club ID → Eventor org ID for all clubs that have logos stored.
   * The frontend uses this to construct /api/club-logo/:eventorId URLs.
   */
  logoMap: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;

    // Collect Eventor IDs with logos from per-competition table
    const logoEventorIds = new Set<number>();
    try {
      await ensureLogoTable(client, ctx.dbName);
      const logos = await client.oxygen_club_logo.findMany({
        select: { EventorId: true },
      });
      for (const l of logos) logoEventorIds.add(l.EventorId);
    } catch {
      // Table might not exist
    }

    // Also check global oxygen_club_db in MeOSMain
    // Build a name→eventorId map so we can resolve clubs with ExtId=0 (non-Eventor competitions)
    const globalNameToEventorId = new Map<string, number>();
    try {
      const mainConn = await getMainDbConnection();
      try {
        await ensureClubDbTable(mainConn);
        const [rows] = await mainConn.execute(
          "SELECT EventorId, Name FROM oxygen_club_db WHERE SmallLogoPng IS NOT NULL",
        );
        for (const r of rows as { EventorId: number; Name: string }[]) {
          logoEventorIds.add(r.EventorId);
          if (r.Name) {
            globalNameToEventorId.set(r.Name.toLowerCase(), r.EventorId);
          }
        }
      } finally {
        await mainConn.end();
      }
    } catch {
      // Global table might not exist yet
    }

    if (logoEventorIds.size === 0) return {};

    const clubs = await client.oClub.findMany({
      where: { Removed: false },
      select: { Id: true, ExtId: true, Name: true },
    });

    const map: Record<number, number> = {};
    for (const c of clubs) {
      const extId = Number(c.ExtId);
      if (extId > 0 && logoEventorIds.has(extId)) {
        map[c.Id] = extId;
      } else if (extId === 0 && c.Name) {
        const match = globalNameToEventorId.get(c.Name.toLowerCase());
        if (match) {
          map[c.Id] = match;
        }
      }
    }
    return map;
  }),
});
