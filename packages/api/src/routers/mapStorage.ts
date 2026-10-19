/**
 * Storage housekeeping by hand (docs/map-storage.md §8.4). The daily run
 * is scheduled on the lease holder (§8.3); this lets an instance admin
 * run it now, or see what it would collect, without moving the schedule.
 */

import { z } from "zod";
import { router, adminProcedure } from "../trpc.js";
import { getSetting, prisma } from "../db.js";
import { GC_SETTINGS, parseGraceDays, runStorageGc } from "../map-store/gc.js";

export const mapStorageRouter = router({
  /** One GC run (§8.2) with the configured grace; `dryRun` lists the candidates and deletes nothing. */
  gcRun: adminProcedure
    .input(z.object({ dryRun: z.boolean().optional() }).optional())
    .mutation(async ({ input }) => {
      const graceDays = parseGraceDays(await getSetting(GC_SETTINGS.graceDays));
      return runStorageGc(prisma(), { graceDays, dryRun: input?.dryRun === true });
    }),
});
