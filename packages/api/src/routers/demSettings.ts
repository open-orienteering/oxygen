/**
 * Settings → Height data (docs/map-terrain.md §7.0b, §7.8). Every
 * procedure is `adminProcedure`, the queries too (§7.0b answer 11). No
 * response carries the Geotorget password: the view is built from
 * `demSettingsStatus`, errors pass through `maskSecret`.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { prisma } from "../db.js";
import { adminProcedure, router } from "../trpc.js";
import { DEM_ACCOUNT_USER } from "../map-store/dem-settings.js";
import { demSettingsStore } from "../map-store/dem-settings-store.js";
import {
  clearDemAccount,
  demSettingsView,
  DemSettingsError,
  listDemMaps,
  retryDemMap,
  saveDemSettings,
  setDemAccount,
  startDemLiveCheck,
} from "../map-store/dem-settings-service.js";

const providersInput = z.object({ lantmateriet: z.boolean(), glo30: z.boolean() });
const resolutionInput = z.union([z.literal(1), z.literal(2)]);

function rethrow(err: unknown): never {
  if (err instanceof DemSettingsError) throw new TRPCError({ code: err.code, message: err.message });
  throw err;
}

export const demSettingsRouter = router({
  get: adminProcedure.query(() => demSettingsView(demSettingsStore, process.env)),

  /** Providers and / or resolution; null resets one to the deploy's default. */
  save: adminProcedure
    .input(z.object({ providers: providersInput.nullable().optional(), resolutionM: resolutionInput.nullable().optional() }))
    .mutation(async ({ input }) => {
      await saveDemSettings(prisma(), demSettingsStore, input);
      return demSettingsView(demSettingsStore, process.env);
    }),

  /** Checks the form only; no request is made (Test connection is the check). */
  setAccount: adminProcedure
    .input(
      z.object({
        user: z.string().trim().min(1).max(200).regex(DEM_ACCOUNT_USER, "the user name must not contain ':' or spaces"),
        password: z.string().min(1).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const requeued = await setDemAccount(prisma(), demSettingsStore, { user: input.user, password: input.password, savedBy: ctx.user?.displayName || ctx.user?.email || null });
      return { requeued, view: await demSettingsView(demSettingsStore, process.env) };
    }),

  clearAccount: adminProcedure.mutation(async () => {
    await clearDemAccount(demSettingsStore);
    return demSettingsView(demSettingsStore, process.env);
  }),

  /** Each club map's DEM state (its newest version). */
  maps: adminProcedure.query(() => listDemMaps(prisma(), demSettingsStore, process.env)),

  retry: adminProcedure.input(z.object({ clubMapId: z.string().uuid() })).mutation(async ({ input }) => {
    try {
      return await retryDemMap(prisma(), input.clubMapId);
    } catch (err) {
      rethrow(err);
    }
  }),

  /** Starts §7.6's live check; the panel polls `get` for its result. */
  testConnection: adminProcedure.input(z.object({ clubMapId: z.string().uuid() })).mutation(async ({ input, ctx }) => {
    try {
      const { record } = await startDemLiveCheck(prisma(), demSettingsStore, process.env, { clubMapId: input.clubMapId, by: ctx.user?.displayName || ctx.user?.email || null });
      return record;
    } catch (err) {
      rethrow(err);
    }
  }),
});
