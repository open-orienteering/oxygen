import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, competitionProcedure } from "../trpc.js";
import {
  onlineInputPuller,
  loadConfig,
  persistConfig,
  pollOnce,
  getLastId,
  setLastId,
  DEFAULT_CONFIG,
} from "../online-input/puller.js";
import {
  loadMapping,
  addMapping,
  removeMapping,
  PUNCH_START,
  PUNCH_FINISH,
  PUNCH_CHECK,
  type SpecialPunch,
} from "../online-input/mapping.js";

const protocolEnum = z.enum(["roc"]);

const specialPunchSchema = z.union([
  z.literal(PUNCH_START),
  z.literal(PUNCH_FINISH),
  z.literal(PUNCH_CHECK),
]);

export const onlineInputRouter = router({
  /** Current configuration + status snapshot for the active competition. */
  getConfig: competitionProcedure.query(async ({ ctx }) => {
    const nameId = ctx.dbName;
    const [config, lastId, mapping] = await Promise.all([
      loadConfig(nameId),
      getLastId(nameId),
      loadMapping(nameId),
    ]);
    return { ...config, lastId, mapping };
  }),

  /** Persist configuration. Restarts the puller if it was running. */
  saveConfig: competitionProcedure
    .input(
      z.object({
        protocol: protocolEnum.optional(),
        endpointUrl: z.string().url().optional(),
        unitId: z.string().max(64).optional(),
        intervalSeconds: z.number().int().min(5).max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const nameId = ctx.dbName;
      const config = await loadConfig(nameId);

      if (input.protocol !== undefined) config.protocol = input.protocol;
      if (input.endpointUrl !== undefined) config.endpointUrl = input.endpointUrl;
      if (input.unitId !== undefined) config.unitId = input.unitId;
      if (input.intervalSeconds !== undefined) config.intervalSeconds = input.intervalSeconds;

      await persistConfig(nameId, config);

      if (config.enabled && onlineInputPuller.isRunning(nameId)) {
        onlineInputPuller.start(nameId, config.intervalSeconds);
      }

      return { success: true };
    }),

  /** Enable + start the puller. Runs an immediate first poll synchronously. */
  enable: competitionProcedure.mutation(async ({ ctx }) => {
    const nameId = ctx.dbName;
    const config = await loadConfig(nameId);

    if (!config.unitId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "No unit ID configured",
      });
    }

    config.enabled = true;
    await persistConfig(nameId, config);

    onlineInputPuller.start(nameId, config.intervalSeconds);
    return { success: true };
  }),

  /** Disable + stop the puller. */
  disable: competitionProcedure.mutation(async ({ ctx }) => {
    const nameId = ctx.dbName;
    onlineInputPuller.stop(nameId);

    const config = await loadConfig(nameId);
    config.enabled = false;
    await persistConfig(nameId, config);

    return { success: true };
  }),

  /** Manual one-shot poll (the "Poll now" button). */
  pollNow: competitionProcedure.mutation(async ({ ctx }) => {
    const nameId = ctx.dbName;
    const stats = await pollOnce(nameId);
    return { success: true, stats };
  }),

  /** Pusher status (running, last poll time, errors, etc.). */
  getStatus: competitionProcedure.query(({ ctx }) => {
    return onlineInputPuller.getStatus(ctx.dbName);
  }),

  /**
   * Reset the lastId watermark. Next poll will fetch the entire history,
   * possibly inserting duplicates of any punches already in oPunch (the
   * caller is warned in the UI).
   */
  clearLastId: competitionProcedure.mutation(async ({ ctx }) => {
    await setLastId(ctx.dbName, 0);
    return { success: true };
  }),

  /** List all current control mappings. */
  getMapping: competitionProcedure.query(async ({ ctx }) => {
    return loadMapping(ctx.dbName);
  }),

  /** Add or replace a single mapping (rawCode → start/finish/check). */
  addMapping: competitionProcedure
    .input(
      z.object({
        rawCode: z.number().int().min(1).max(1023),
        target: specialPunchSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const mapping = await addMapping(
        ctx.dbName,
        input.rawCode,
        input.target as SpecialPunch,
      );
      return { success: true, mapping };
    }),

  /** Remove a single mapping. */
  removeMapping: competitionProcedure
    .input(z.object({ rawCode: z.number().int().min(1).max(1023) }))
    .mutation(async ({ ctx, input }) => {
      const mapping = await removeMapping(ctx.dbName, input.rawCode);
      return { success: true, mapping };
    }),

  /** Static defaults useful to the UI. */
  getDefaults: competitionProcedure.query(() => {
    return {
      ...DEFAULT_CONFIG,
      specialPunches: {
        start: PUNCH_START,
        finish: PUNCH_FINISH,
        check: PUNCH_CHECK,
      },
    };
  }),
});
