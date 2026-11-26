import { randomInt } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "../generated/prisma/client.js";
import { router, viewProcedure, manageRaceProcedure } from "../trpc.js";
import { toRelative, toAbsolute } from "../timeConvert.js";
import { generateDrawPreview, MAX_DRAW_SEED } from "../draw/index.js";
import type { DrawPreviewResult } from "@oxygen/shared";
import { WITHDRAWN_STATUSES } from "@oxygen/shared";
import { valueToRunnerStatus } from "../statusConvert.js";
import { appendJournalMany } from "../journalEmit.js";
import { emitClassUpserted } from "../referenceJournal.js";
import { lockEventLeaseAndSync } from "../event-locks.js";
import { mayWriteEventData, writeRefusalError } from "../sync/lease.js";

const classDrawConfigSchema = z.object({
  classId: z.number().int(),
  method: z.enum(["random", "clubSeparation", "seeded", "simultaneous"]),
  interval: z.number().int().min(0),
  firstStart: z.number().int().optional(),
  corridorHint: z.number().int().optional(),
  orderHint: z.number().int().optional(),
  startOffset: z.number().int().optional(),
});

const drawSettingsSchema = z.object({
  firstStart: z.number().int(),
  baseInterval: z.number().int().min(0),
  maxParallelStarts: z.number().int().min(1).max(50),
  detectCourseOverlap: z.boolean(),
  staggerOffset: z.number().int().min(0).optional(),
  minFirstControlGap: z.number().int().min(0).optional(),
});

const drawOptionsSchema = z
  .object({
    mode: z.enum(["all", "onlyMissing"]).default("all"),
    force: z.boolean().default(false),
  })
  .default({ mode: "all", force: false });

const seedSchema = z.number().int().min(0).max(MAX_DRAW_SEED);

const drawPreviewInputSchema = z.object({
  classes: z.array(classDrawConfigSchema).min(1),
  settings: drawSettingsSchema,
  options: drawOptionsSchema,
  /** Reuse a seed (e.g. re-preview after a drag) so the order stays. */
  seed: seedSchema.optional(),
});

const drawExecuteInputSchema = z.object({
  classes: z.array(classDrawConfigSchema).min(1),
  settings: drawSettingsSchema,
  options: drawOptionsSchema,
  /** The seed and token the preview returned (RES-15). */
  seed: seedSchema,
  previewToken: z.string().min(1),
});

/** A big draw is many rows; one transaction, so give it room (nginx allows 120 s). */
const DRAW_TX_OPTIONS = { timeout: 110_000, maxWait: 10_000 } as const;

export const STALE_PREVIEW_MESSAGE =
  "The draw preview is stale: runners or classes changed since it was made. Preview again before applying.";

const withdrawnEnums = WITHDRAWN_STATUSES.map(valueToRunnerStatus);

export const drawRouter = router({
  /** Default settings + per-class meta for the draw panel. */
  defaults: viewProcedure.query(async ({ ctx }) => {
    const eventId = ctx.event.id;
    const zeroTime = ctx.event.zeroTime;

    const classes = await ctx.db.class.findMany({
      where: { eventId, removed: false },
      include: { course: { select: { seq: true, name: true } } },
      orderBy: { sortIndex: "asc" },
    });

    const runners = await ctx.db.runner.findMany({
      where: {
        eventId,
        removed: false,
        status: { notIn: withdrawnEnums },
      },
      select: { classId: true, startTime: true, finishTime: true, status: true },
    });
    const countByClassId = new Map<string, number>();
    // Runners with a start time, and runners who have finished or have a
    // status: the panel preselects only undrawn classes (RES-03). The draw
    // itself also counts read cards and punches as "started".
    const drawnByClassId = new Map<string, number>();
    const startedByClassId = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const r of runners) {
      if (!r.classId) continue;
      bump(countByClassId, r.classId);
      if (r.startTime !== 0) bump(drawnByClassId, r.classId);
      if (r.finishTime !== 0 || r.status !== "unknown") bump(startedByClassId, r.classId);
    }

    return {
      zeroTime,
      classes: classes.map((c) => ({
        id: c.seq,
        name: c.name,
        courseId: c.course?.seq ?? 0,
        courseName: c.course?.name ?? "",
        runnerCount: countByClassId.get(c.id) ?? 0,
        drawnCount: drawnByClassId.get(c.id) ?? 0,
        startedCount: startedByClassId.get(c.id) ?? 0,
        firstStart: toAbsolute(c.firstStart, zeroTime),
        startInterval: c.startInterval,
        freeStart: c.freeStart,
        classType: c.classType,
      })),
    };
  }),

  /** Generate a draw preview without persisting. */
  preview: viewProcedure
    .input(drawPreviewInputSchema)
    .mutation(async ({ ctx, input }): Promise<DrawPreviewResult> => {
      const seed = input.seed ?? randomInt(0, MAX_DRAW_SEED);
      const result = await generateDrawPreview(
        ctx.db,
        ctx.event.id,
        ctx.event.zeroTime,
        input.classes,
        input.settings,
        seed,
        input.options,
      );
      return {
        warnings: result.warnings,
        seed: result.seed,
        previewToken: result.previewToken,
        skippedStarted: result.skippedStarted,
        replaced: result.replaced,
        classes: result.classes.map((c) => ({
          classId: c.classId,
          className: c.className,
          courseName: c.courseName,
          corridor: c.corridor,
          computedFirstStart: c.computedFirstStart,
          interval: c.interval,
          skippedStarted: c.skippedStarted,
          replaced: c.replaced,
          entries: c.entries.map((e) => ({
            runnerId: e.runnerSeq,
            name: e.name,
            clubName: e.clubName,
            startTime: e.startTime,
            startNo: e.startNo,
          })),
        })),
      };
    }),

  /**
   * Execute the draw: writes start times + start numbers to runners,
   * and FirstStart + StartInterval to each class. Times are stored
   * ZeroTime-relative; the engine speaks absolute deciseconds.
   *
   * Applies exactly the previewed draw (RES-15): the draw is recomputed from
   * the preview's seed inside the transaction and refused if its token
   * differs. All of it commits or none of it does (RES-09), under the
   * per-event lock that also orders the Eventor sync and a checkout, with
   * the lease re-checked after taking it.
   */
  execute: manageRaceProcedure
    .input(drawExecuteInputSchema)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<{
        success: boolean;
        totalDrawn: number;
        skippedStarted: number;
        replaced: number;
        warnings: string[];
      }> => {
        const eventId = ctx.event.id;
        const zeroTime = ctx.event.zeroTime;
        const configByClassSeq = new Map(input.classes.map((c) => [c.classId, c]));

        return ctx.db.$transaction(async (tx) => {
          await lockEventLeaseAndSync(tx, eventId);
          const verdict = await mayWriteEventData(tx, eventId);
          if (!verdict.ok) throw writeRefusalError(verdict);

          const result = await generateDrawPreview(
            tx,
            eventId,
            zeroTime,
            input.classes,
            input.settings,
            input.seed,
            input.options,
          );
          if (result.previewToken !== input.previewToken) {
            throw new TRPCError({ code: "CONFLICT", message: STALE_PREVIEW_MESSAGE });
          }

          const entries = result.classes.flatMap((c) => c.entries);
          if (entries.length > 0) {
            // One statement for every runner. Arrays keep the bind-parameter
            // count constant whatever the size of the draw.
            const ids = entries.map((e) => e.runnerId);
            const starts = entries.map((e) => toRelative(e.startTime, zeroTime));
            const nos = entries.map((e) => e.startNo);
            const updated = await tx.$executeRaw(Prisma.sql`
              UPDATE oxygen.runners AS r
                 SET start_time = v.st, start_no = v.no
                FROM unnest(${ids}::uuid[], ${starts}::int[], ${nos}::int[]) AS v(id, st, no)
               WHERE r.id = v.id AND r.event_id = ${eventId}`);
            if (updated !== entries.length) {
              throw new TRPCError({ code: "CONFLICT", message: STALE_PREVIEW_MESSAGE });
            }
            await appendJournalMany(tx, {
              eventId,
              type: "start.adjusted",
              payloads: entries.map((e) => ({
                cardNo: e.cardNo,
                runnerId: e.runnerSeq,
                startTime: e.startTime, // absolute deciseconds (portable)
                startNo: e.startNo,
              })),
            });
          }

          for (const cls of result.classes) {
            const config = configByClassSeq.get(cls.classId);
            if (!config || !cls.writesClass) continue;
            // Class draw settings + class.upserted journal entry (reference
            // data journals as full-row LWW upserts).
            await tx.class.update({
              where: { id: cls.classUuid },
              data: {
                firstStart: toRelative(cls.computedFirstStart, zeroTime),
                startInterval: config.interval,
              },
            });
            await emitClassUpserted(tx, eventId, cls.classUuid);
          }

          return {
            success: true,
            totalDrawn: entries.length,
            skippedStarted: result.skippedStarted,
            replaced: result.replaced,
            warnings: result.warnings,
          };
        }, DRAW_TX_OPTIONS);
      },
    ),
});
