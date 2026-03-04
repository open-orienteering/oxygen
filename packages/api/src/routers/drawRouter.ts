import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient, incrementCounter } from "../db.js";
import { generateDrawPreview } from "../draw/index.js";
import type { DrawPreviewResult } from "@oxygen/shared";

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

export const drawRouter = router({
  /**
   * Get default settings and class info for the draw panel.
   */
  defaults: publicProcedure.query(async () => {
    const client = await getCompetitionClient();

    const event = await client.oEvent.findFirst({ where: { Removed: false } });
    const zeroTime = event?.ZeroTime ?? 324000;

    const classes = await client.oClass.findMany({
      where: { Removed: false },
      orderBy: { SortIndex: "asc" },
    });

    const courses = await client.oCourse.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true },
    });
    const courseMap = new Map(courses.map((c) => [c.Id, c.Name]));

    const runners = await client.oRunner.findMany({
      where: { Removed: false },
      select: { Class: true },
    });
    const countByClass = new Map<number, number>();
    for (const r of runners) {
      countByClass.set(r.Class, (countByClass.get(r.Class) ?? 0) + 1);
    }

    return {
      zeroTime,
      classes: classes.map((c) => ({
        id: c.Id,
        name: c.Name,
        courseId: c.Course,
        courseName: courseMap.get(c.Course) ?? "",
        runnerCount: countByClass.get(c.Id) ?? 0,
        firstStart: c.FirstStart,
        startInterval: c.StartInterval,
        freeStart: c.FreeStart === 1,
      })),
    };
  }),

  /**
   * Generate a draw preview without saving.
   * Returns proposed start times and start numbers for review.
   */
  preview: publicProcedure
    .input(drawInputSchema)
    .mutation(async ({ input }): Promise<DrawPreviewResult> => {
      const client = await getCompetitionClient();
      return generateDrawPreview(client, input.classes, input.settings);
    }),

  /**
   * Execute the draw: generate start times and persist to database.
   * Updates oRunner.StartTime, oRunner.StartNo, oClass.FirstStart,
   * and oClass.StartInterval for each drawn class.
   */
  execute: publicProcedure
    .input(drawInputSchema)
    .mutation(async ({ input }): Promise<{ success: boolean; totalDrawn: number; warnings: string[] }> => {
      const client = await getCompetitionClient();
      const result = await generateDrawPreview(client, input.classes, input.settings);

      let totalDrawn = 0;
      const configMap = new Map(input.classes.map((c) => [c.classId, c]));

      for (const cls of result.classes) {
        const config = configMap.get(cls.classId);

        // Update each runner's start time and start number
        for (const entry of cls.entries) {
          await client.oRunner.update({
            where: { Id: entry.runnerId },
            data: {
              StartTime: entry.startTime,
              StartNo: entry.startNo,
            },
          });
          await incrementCounter("oRunner", entry.runnerId);
          totalDrawn++;
        }

        // Update class FirstStart and StartInterval
        if (config) {
          await client.oClass.update({
            where: { Id: cls.classId },
            data: {
              FirstStart: cls.computedFirstStart,
              StartInterval: config.interval,
            },
          });
          await incrementCounter("oClass", cls.classId);
        }
      }

      return {
        success: true,
        totalDrawn,
        warnings: result.warnings,
      };
    }),
});
