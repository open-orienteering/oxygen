import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";
import { toRelative, toAbsolute } from "../timeConvert.js";
import { generateDrawPreview } from "../draw/index.js";
import type { DrawPreviewResult } from "@oxygen/shared";
import { WITHDRAWN_STATUSES } from "@oxygen/shared";
import { valueToRunnerStatus } from "../statusConvert.js";
import { appendJournal } from "../journalEmit.js";

const classDrawConfigSchema = z.object({
  classId: z.number().int(),
  method: z.enum(["random", "clubSeparation", "seeded", "simultaneous"]),
  interval: z.number().int().min(0),
  firstStart: z.number().int().optional(),
  corridorHint: z.number().int().optional(),
  orderHint: z.number().int().optional(),
});

const drawSettingsSchema = z.object({
  firstStart: z.number().int(),
  baseInterval: z.number().int().min(0),
  maxParallelStarts: z.number().int().min(1).max(50),
  detectCourseOverlap: z.boolean(),
});

const drawInputSchema = z.object({
  classes: z.array(classDrawConfigSchema).min(1),
  settings: drawSettingsSchema,
});

const withdrawnEnums = WITHDRAWN_STATUSES.map(valueToRunnerStatus);

export const drawRouter = router({
  /** Default settings + per-class meta for the draw panel. */
  defaults: eventProcedure.query(async ({ ctx }) => {
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
      select: { classId: true },
    });
    const countByClassId = new Map<string, number>();
    for (const r of runners) {
      if (!r.classId) continue;
      countByClassId.set(r.classId, (countByClassId.get(r.classId) ?? 0) + 1);
    }

    return {
      zeroTime,
      classes: classes.map((c) => ({
        id: c.seq,
        name: c.name,
        courseId: c.course?.seq ?? 0,
        courseName: c.course?.name ?? "",
        runnerCount: countByClassId.get(c.id) ?? 0,
        firstStart: toAbsolute(c.firstStart, zeroTime),
        startInterval: c.startInterval,
        freeStart: c.freeStart,
        classType: c.classType,
      })),
    };
  }),

  /** Generate a draw preview without persisting. */
  preview: eventProcedure
    .input(drawInputSchema)
    .mutation(async ({ ctx, input }): Promise<DrawPreviewResult> => {
      const result = await generateDrawPreview(
        ctx.db,
        ctx.event.id,
        input.classes,
        input.settings,
      );
      // Internal entries carry UUIDs; map back to runner seqs for the UI.
      const runnerUuids = result.classes.flatMap((c) =>
        c.entries.map((e) => e.runnerId),
      );
      const runnerSeqs = runnerUuids.length
        ? await ctx.db.runner.findMany({
            where: { id: { in: runnerUuids } },
            select: { id: true, seq: true },
          })
        : [];
      const seqByUuid = new Map(runnerSeqs.map((r) => [r.id, r.seq]));
      return {
        warnings: result.warnings,
        classes: result.classes.map((c) => ({
          classId: c.classId,
          className: c.className,
          courseName: c.courseName,
          corridor: c.corridor,
          computedFirstStart: c.computedFirstStart,
          entries: c.entries.map((e) => ({
            runnerId: seqByUuid.get(e.runnerId) ?? 0,
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
   */
  execute: eventProcedure
    .input(drawInputSchema)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<{ success: boolean; totalDrawn: number; warnings: string[] }> => {
        const zeroTime = ctx.event.zeroTime;
        const result = await generateDrawPreview(
          ctx.db,
          ctx.event.id,
          input.classes,
          input.settings,
        );

        const configByClassSeq = new Map(
          input.classes.map((c) => [c.classId, c]),
        );

        // Map drawn runner UUIDs → { seq, cardNo } so the journal payloads are
        // node-portable (resolve by card, fall back to seq).
        const drawnUuids = result.classes.flatMap((c) =>
          c.entries.map((e) => e.runnerId),
        );
        const drawnRunners = drawnUuids.length
          ? await ctx.db.runner.findMany({
              where: { id: { in: drawnUuids } },
              select: { id: true, seq: true, cardNo: true },
            })
          : [];
        const metaByUuid = new Map(drawnRunners.map((r) => [r.id, r]));

        let totalDrawn = 0;
        for (const cls of result.classes) {
          const config = configByClassSeq.get(cls.classId);

          for (const entry of cls.entries) {
            const meta = metaByUuid.get(entry.runnerId);
            // Runner start time + journal entry commit or roll back together.
            await ctx.db.$transaction(async (tx) => {
              await tx.runner.update({
                where: { id: entry.runnerId },
                data: {
                  startTime: toRelative(entry.startTime, zeroTime),
                  startNo: entry.startNo,
                },
              });
              await appendJournal(tx, {
                eventId: ctx.event.id,
                type: "start.adjusted",
                payload: {
                  cardNo: meta?.cardNo ?? null,
                  runnerId: meta?.seq,
                  startTime: entry.startTime, // absolute deciseconds (portable)
                },
              });
            });
            totalDrawn++;
          }

          // The per-class FirstStart / StartInterval write is class reference
          // data (not journaled in pivot Step 2 — see docs/offline-architecture
          // "Reference data" deferral). The runner start times above are the
          // race-critical, journaled facts.
          if (config) {
            await ctx.db.class.update({
              where: { id: cls.classUuid },
              data: {
                firstStart: toRelative(cls.computedFirstStart, zeroTime),
                startInterval: config.interval,
              },
            });
          }
        }

        return { success: true, totalDrawn, warnings: result.warnings };
      },
    ),
});
