import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient } from "../db.js";
import type { ControlInfo, ControlDetail } from "@oxygen/shared";

export const controlRouter = router({
  /**
   * List all controls.
   */
  list: publicProcedure
    .input(
      z
        .object({
          search: z.string().optional(),
          status: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }): Promise<ControlInfo[]> => {
      const client = await getCompetitionClient();

      const controls = await client.oControl.findMany({
        where: { Removed: false },
        orderBy: { Id: "asc" },
      });

      let filtered = controls;

      // Filter by status
      if (input?.status !== undefined) {
        filtered = filtered.filter((c) => c.Status === input.status);
      }

      // Filter by search (name or code)
      if (input?.search) {
        const term = input.search.toLowerCase();
        filtered = filtered.filter(
          (c) =>
            c.Name.toLowerCase().includes(term) ||
            c.Numbers.toLowerCase().includes(term) ||
            String(c.Id).includes(term),
        );
      }

      // Compute runner counts per control
      const courses = await client.oCourse.findMany({
        where: { Removed: false },
        select: { Id: true, Controls: true, StartName: true, FirstAsStart: true, LastAsFinish: true },
      });
      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Course: true },
      });
      const runners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { Class: true },
      });
      const runnersByClass = new Map<number, number>();
      for (const r of runners) {
        runnersByClass.set(r.Class, (runnersByClass.get(r.Class) ?? 0) + 1);
      }
      const runnersPerCourse = new Map<number, number>();
      for (const cl of classes) {
        if (cl.Course > 0) {
          runnersPerCourse.set(cl.Course, (runnersPerCourse.get(cl.Course) ?? 0) + (runnersByClass.get(cl.Id) ?? 0));
        }
      }
      // controlId → total runner count
      const controlRunnerCount = new Map<number, number>();
      for (const course of courses) {
        const courseRunners = runnersPerCourse.get(course.Id) ?? 0;
        if (courseRunners === 0) continue;
        const ctrlIds = new Set<number>();
        for (const idStr of course.Controls.split(";").filter(Boolean)) {
          const id = parseInt(idStr, 10);
          if (!isNaN(id)) ctrlIds.add(id);
        }
        for (const ctrlId of ctrlIds) {
          controlRunnerCount.set(ctrlId, (controlRunnerCount.get(ctrlId) ?? 0) + courseRunners);
        }
      }

      // Handle Start (Status 4) and Finish (Status 5) controls.
      // In MeOS, start/finish aren't stored in oCourse.Controls — they're separate.
      // - If FirstAsStart=1, the first control in Controls IS the start (already counted above).
      // - If FirstAsStart=0, a physical start station (STA1/STA2) is used.
      // - Same logic for LastAsFinish and finish stations.
      // We match start controls to courses via the StartName field.
      // For finish, all courses share the finish unless there are multiple finishes.
      const startControls = filtered.filter((c) => c.Status === 4);
      const finishControls = filtered.filter((c) => c.Status === 5);

      if (startControls.length > 0) {
        // Build a map: startName → controlId (matching control Name to course StartName)
        const startNameToCtrl = new Map<string, number>();
        for (const sc of startControls) {
          startNameToCtrl.set(sc.Name.toUpperCase(), sc.Id);
        }
        // Default start (empty StartName) → first start control
        const defaultStartId = startControls[0].Id;

        for (const course of courses) {
          if (course.FirstAsStart) continue; // first control already counted
          const courseRunners = runnersPerCourse.get(course.Id) ?? 0;
          if (courseRunners === 0) continue;
          const startKey = course.StartName.trim().toUpperCase();
          const startCtrlId = (startKey && startNameToCtrl.get(startKey)) || defaultStartId;
          controlRunnerCount.set(startCtrlId, (controlRunnerCount.get(startCtrlId) ?? 0) + courseRunners);
        }
      }

      if (finishControls.length > 0) {
        // MeOS has no FinishName on courses. If there's one finish, all non-LastAsFinish
        // courses use it. If multiple, we assign to the first one.
        const defaultFinishId = finishControls[0].Id;

        for (const course of courses) {
          if (course.LastAsFinish) continue; // last control already counted
          const courseRunners = runnersPerCourse.get(course.Id) ?? 0;
          if (courseRunners === 0) continue;
          controlRunnerCount.set(defaultFinishId, (controlRunnerCount.get(defaultFinishId) ?? 0) + courseRunners);
        }
      }

      return filtered.map(
        (c): ControlInfo => ({
          id: c.Id,
          name: c.Name,
          codes: c.Numbers,
          status: c.Status as ControlInfo["status"],
          timeAdjust: c.TimeAdjust,
          minTime: c.MinTime,
          runnerCount: controlRunnerCount.get(c.Id) ?? 0,
        }),
      );
    }),

  /**
   * Get a single control with detailed course usage info.
   */
  detail: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }): Promise<ControlDetail | null> => {
      const client = await getCompetitionClient();

      const control = await client.oControl.findFirst({
        where: { Id: input.id, Removed: false },
      });
      if (!control) return null;

      // Get all courses and classes to compute usage
      const courses = await client.oCourse.findMany({
        where: { Removed: false },
      });
      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Course: true },
      });

      // Count runners per class
      const runners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { Class: true },
      });
      const runnersByClass = new Map<number, number>();
      for (const r of runners) {
        runnersByClass.set(r.Class, (runnersByClass.get(r.Class) ?? 0) + 1);
      }

      // Map course ID to runner count (sum of all classes using that course)
      const runnersByCourse = new Map<number, number>();
      for (const cls of classes) {
        if (cls.Course > 0) {
          const current = runnersByCourse.get(cls.Course) ?? 0;
          runnersByCourse.set(
            cls.Course,
            current + (runnersByClass.get(cls.Id) ?? 0),
          );
        }
      }

      // Find which courses use this control (by checking the codes)
      const controlCodes = control.Numbers.split(";")
        .map((s) => s.trim())
        .filter(Boolean);

      const courseUsage: ControlDetail["courses"] = [];
      for (const course of courses) {
        const courseControls = course.Controls.split(";").filter(Boolean);
        let occurrences = 0;
        for (const cc of courseControls) {
          if (controlCodes.includes(cc)) {
            occurrences++;
          }
        }
        if (occurrences > 0) {
          courseUsage.push({
            courseId: course.Id,
            courseName: course.Name,
            occurrences,
            runnerCount: runnersByCourse.get(course.Id) ?? 0,
          });
        }
      }

      return {
        id: control.Id,
        name: control.Name,
        codes: control.Numbers,
        status: control.Status as ControlInfo["status"],
        timeAdjust: control.TimeAdjust,
        minTime: control.MinTime,
        runnerCount: courseUsage.reduce((sum, c) => sum + c.runnerCount, 0),
        courses: courseUsage,
      };
    }),

  /**
   * Create a new control.
   */
  create: publicProcedure
    .input(
      z.object({
        codes: z.string().min(1),
        name: z.string().optional().default(""),
        status: z.number().int().optional().default(0),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      // Use the first numeric code as the ID
      const firstCode = parseInt(
        input.codes.split(";")[0]?.trim() ?? "0",
        10,
      );
      if (isNaN(firstCode) || firstCode <= 0) {
        throw new Error("Invalid control code — must be a positive number");
      }

      // Check if control with that ID already exists (active)
      const existing = await client.oControl.findFirst({
        where: { Id: firstCode },
      });

      let control;
      if (existing && !existing.Removed) {
        throw new Error(`Control ${firstCode} already exists`);
      } else if (existing && existing.Removed) {
        // Re-activate a previously deleted control
        control = await client.oControl.update({
          where: { Id: firstCode },
          data: {
            Numbers: input.codes,
            Name: input.name,
            Status: input.status,
            Removed: false,
          },
        });
      } else {
        control = await client.oControl.create({
          data: {
            Id: firstCode,
            Numbers: input.codes,
            Name: input.name,
            Status: input.status,
          },
        });
      }

      return {
        id: control.Id,
        name: control.Name,
        codes: control.Numbers,
      };
    }),

  /**
   * Update an existing control.
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        codes: z.string().optional(),
        status: z.number().int().optional(),
        timeAdjust: z.number().int().optional(),
        minTime: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.Name = input.name;
      if (input.codes !== undefined) data.Numbers = input.codes;
      if (input.status !== undefined) data.Status = input.status;
      if (input.timeAdjust !== undefined) data.TimeAdjust = input.timeAdjust;
      if (input.minTime !== undefined) data.MinTime = input.minTime;

      const control = await client.oControl.update({
        where: { Id: input.id },
        data,
      });

      return {
        id: control.Id,
        name: control.Name,
        codes: control.Numbers,
        status: control.Status,
      };
    }),

  /**
   * Soft-delete a control.
   */
  delete: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      await client.oControl.update({
        where: { Id: input.id },
        data: { Removed: true },
      });

      return { success: true };
    }),
});
