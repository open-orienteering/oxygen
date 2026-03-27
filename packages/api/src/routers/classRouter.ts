import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient } from "../db.js";
import {
  parseMultiCourse,
  encodeMultiCourse,
  type ClassSummary,
  type ClassManageDetail,
} from "@oxygen/shared";

export const classRouter = router({
  /**
   * List all classes.
   */
  list: publicProcedure
    .input(
      z.object({ search: z.string().optional() }).optional(),
    )
    .query(async ({ input }): Promise<ClassSummary[]> => {
      const client = await getCompetitionClient();

      const classes = await client.oClass.findMany({
        where: { Removed: false },
        orderBy: { SortIndex: "asc" },
      });

      const courses = await client.oCourse.findMany({
        where: { Removed: false },
      });
      const courseMap = new Map(courses.map((c) => [c.Id, c]));

      const runners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { Class: true },
      });
      const runnerCountByClass = new Map<number, number>();
      for (const r of runners) {
        runnerCountByClass.set(r.Class, (runnerCountByClass.get(r.Class) ?? 0) + 1);
      }

      let result = classes.map((c): ClassSummary => {
        // Determine all course IDs (single or forked)
        const multiStages = parseMultiCourse(c.MultiCourse);
        const allForkedIds = multiStages.flat();
        const courseIds =
          allForkedIds.length > 0
            ? allForkedIds
            : c.Course > 0
              ? [c.Course]
              : [];

        const courseNames = courseIds.map(
          (id) => courseMap.get(id)?.Name ?? `#${id}`,
        );
        const primaryCourse = courseMap.get(c.Course);

        return {
          id: c.Id,
          name: c.Name,
          courseId: c.Course,
          courseName: primaryCourse?.Name ?? "",
          courseIds,
          courseNames,
          runnerCount: runnerCountByClass.get(c.Id) ?? 0,
          sortIndex: c.SortIndex,
          sex: c.Sex,
          lowAge: c.LowAge,
          highAge: c.HighAge,
          freeStart: c.FreeStart === 1,
          noTiming: c.NoTiming === 1,
          allowQuickEntry: c.AllowQuickEntry === 1,
          classType: c.ClassType,
          classFee: c.ClassFee,
          maxTime: c.MaxTime,
        };
      });

      if (input?.search) {
        const term = input.search.toLowerCase();
        result = result.filter(
          (c) =>
            c.name.toLowerCase().includes(term) ||
            c.courseNames.some((n) => n.toLowerCase().includes(term)) ||
            String(c.id).includes(term),
        );
      }

      return result;
    }),

  /**
   * Get a single class with full details.
   */
  detail: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }): Promise<ClassManageDetail | null> => {
      const client = await getCompetitionClient();

      const cls = await client.oClass.findFirst({
        where: { Id: input.id, Removed: false },
      });
      if (!cls) return null;

      const courses = await client.oCourse.findMany({
        where: { Removed: false },
      });
      const courseMap = new Map(courses.map((c) => [c.Id, c]));

      const multiStages = parseMultiCourse(cls.MultiCourse);
      const allForkedIds = multiStages.flat();
      const courseIds =
        allForkedIds.length > 0
          ? allForkedIds
          : cls.Course > 0
            ? [cls.Course]
            : [];
      const courseNames = courseIds.map(
        (id) => courseMap.get(id)?.Name ?? `#${id}`,
      );

      const primaryCourse = courseMap.get(cls.Course);
      const controlCount = primaryCourse
        ? primaryCourse.Controls.split(";").filter(Boolean).length
        : 0;

      // Get runners in this class (limited fields)
      const runners = await client.oRunner.findMany({
        where: { Removed: false, Class: cls.Id },
        select: { Id: true, Name: true, Status: true },
        orderBy: { StartNo: "asc" },
      });

      return {
        id: cls.Id,
        name: cls.Name,
        courseId: cls.Course,
        courseName: primaryCourse?.Name ?? "",
        courseIds,
        courseNames,
        runnerCount: runners.length,
        sortIndex: cls.SortIndex,
        sex: cls.Sex,
        lowAge: cls.LowAge,
        highAge: cls.HighAge,
        freeStart: cls.FreeStart === 1,
        noTiming: cls.NoTiming === 1,
        allowQuickEntry: cls.AllowQuickEntry === 1,
        classType: cls.ClassType,
        classFee: cls.ClassFee,
        maxTime: cls.MaxTime,
        longName: cls.LongName,
        firstStart: cls.FirstStart,
        startInterval: cls.StartInterval,
        courseLength: primaryCourse?.Length ?? 0,
        controlCount,
        runners: runners.map((r) => ({
          id: r.Id,
          name: r.Name,
          status: r.Status,
        })),
      };
    }),

  /**
   * Create a new class.
   */
  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        courseIds: z.array(z.number().int()).optional().default([]),
        sortIndex: z.number().int().optional().default(0),
        sex: z.string().optional().default(""),
        lowAge: z.number().int().optional().default(0),
        highAge: z.number().int().optional().default(0),
        freeStart: z.boolean().optional().default(false),
        noTiming: z.boolean().optional().default(false),
        allowQuickEntry: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const courseId = input.courseIds.length > 0 ? input.courseIds[0] : 0;
      const multiCourse =
        input.courseIds.length > 1
          ? encodeMultiCourse(input.courseIds)
          : "";

      const cls = await client.oClass.create({
        data: {
          Name: input.name,
          Course: courseId,
          MultiCourse: multiCourse,
          Qualification: "",
          SortIndex: input.sortIndex,
          Sex: input.sex,
          LowAge: input.lowAge,
          HighAge: input.highAge,
          FreeStart: input.freeStart ? 1 : 0,
          NoTiming: input.noTiming ? 1 : 0,
          AllowQuickEntry: input.allowQuickEntry ? 1 : 0,
        },
      });

      return { id: cls.Id, name: cls.Name };
    }),

  /**
   * Update an existing class.
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        courseIds: z.array(z.number().int()).optional(),
        sortIndex: z.number().int().optional(),
        sex: z.string().optional(),
        lowAge: z.number().int().optional(),
        highAge: z.number().int().optional(),
        freeStart: z.boolean().optional(),
        noTiming: z.boolean().optional(),
        allowQuickEntry: z.boolean().optional(),
        firstStart: z.number().int().optional(),
        startInterval: z.number().int().optional(),
        classFee: z.number().int().optional(),
        maxTime: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.Name = input.name;
      if (input.sortIndex !== undefined) data.SortIndex = input.sortIndex;
      if (input.sex !== undefined) data.Sex = input.sex;
      if (input.lowAge !== undefined) data.LowAge = input.lowAge;
      if (input.highAge !== undefined) data.HighAge = input.highAge;
      if (input.freeStart !== undefined)
        data.FreeStart = input.freeStart ? 1 : 0;
      if (input.noTiming !== undefined)
        data.NoTiming = input.noTiming ? 1 : 0;
      if (input.allowQuickEntry !== undefined)
        data.AllowQuickEntry = input.allowQuickEntry ? 1 : 0;
      if (input.firstStart !== undefined) data.FirstStart = input.firstStart;
      if (input.startInterval !== undefined)
        data.StartInterval = input.startInterval;
      if (input.classFee !== undefined) data.ClassFee = input.classFee;
      if (input.maxTime !== undefined) data.MaxTime = input.maxTime;

      // Handle course assignment
      if (input.courseIds !== undefined) {
        data.Course = input.courseIds.length > 0 ? input.courseIds[0] : 0;
        data.MultiCourse =
          input.courseIds.length > 1
            ? encodeMultiCourse(input.courseIds)
            : "";
      }

      const cls = await client.oClass.update({
        where: { Id: input.id },
        data,
      });

      return { id: cls.Id, name: cls.Name };
    }),

  /**
   * Batch-reorder classes by updating SortIndex.
   */
  reorder: publicProcedure
    .input(
      z.object({
        items: z.array(
          z.object({
            id: z.number().int(),
            sortIndex: z.number().int(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      await Promise.all(
        input.items.map((item) =>
          client.oClass.update({
            where: { Id: item.id },
            data: { SortIndex: item.sortIndex },
          }),
        ),
      );

      return { success: true };
    }),

  /**
   * Bulk-update multiple classes at once.
   */
  bulkUpdate: publicProcedure
    .input(
      z.object({
        ids: z.array(z.number().int()).min(1).max(500),
        data: z.object({
          classFee: z.number().int().optional(),
          freeStart: z.boolean().optional(),
          noTiming: z.boolean().optional(),
          allowQuickEntry: z.boolean().optional(),
          maxTime: z.number().int().min(0).optional(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      let updated = 0;
      const data: Record<string, unknown> = {};
      if (input.data.classFee !== undefined) data.ClassFee = input.data.classFee;
      if (input.data.freeStart !== undefined) data.FreeStart = input.data.freeStart ? 1 : 0;
      if (input.data.noTiming !== undefined) data.NoTiming = input.data.noTiming ? 1 : 0;
      if (input.data.allowQuickEntry !== undefined) data.AllowQuickEntry = input.data.allowQuickEntry ? 1 : 0;
      if (input.data.maxTime !== undefined) data.MaxTime = input.data.maxTime;

      for (const id of input.ids) {
        await client.oClass.update({
          where: { Id: id },
          data,
        });
        updated++;
      }

      return { updated };
    }),

  /**
   * Soft-delete a class.
   */
  delete: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      await client.oClass.update({
        where: { Id: input.id },
        data: { Removed: true },
      });

      return { success: true };
    }),
});
