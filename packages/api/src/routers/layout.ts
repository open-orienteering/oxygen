/**
 * Templates by key, sheets and class overrides (docs/course-layout.md §5–§6;
 * research 08 §4.4, §4.6, §6 `layout.autoSheets`). Layout data is
 * cloud-owned and not journaled (08 §4.8); the class override columns are
 * left out of `class.upserted` (`referenceJournal.ts`).
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { autoSheets, type AutoSheetsResult } from "../course-maps/auto-sheets.js";
import { coursesEditProcedure, coursesViewProcedure, router } from "../trpc.js";

export interface ClassOverrideRow {
  seq: number;
  name: string;
  printScale: number | null;
  /** The `sheet_template_id` template's seq. */
  sheetTemplateSeq: number | null;
  /** The class's own sheets (seqs). */
  sheets: number[];
}

export const layoutRouter = router({
  /**
   * Ensure a course's first sheet on its key's auto template and its
   * overriding classes' sheets (`autoSheets`); without `courseId`, every
   * course of the event (Export ▾ "all courses"). Idempotent.
   */
  autoSheets: coursesEditProcedure
    .input(z.object({ courseId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }): Promise<AutoSheetsResult> => {
      const courses = await ctx.db.course.findMany({
        where: { eventId: ctx.event.id, removed: false, ...(input.courseId !== undefined ? { seq: input.courseId } : {}) },
        select: { id: true },
        orderBy: { seq: "asc" },
      });
      if (input.courseId !== undefined && courses.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      return ctx.db.$transaction(async (tx) => {
        const out: AutoSheetsResult = { createdSheets: [], createdTemplates: [], courseSheets: [], classSheets: {} };
        for (const c of courses) {
          const r = await autoSheets(tx, ctx.event.id, c.id);
          out.createdSheets.push(...r.createdSheets);
          out.createdTemplates.push(...r.createdTemplates);
          out.courseSheets.push(...r.courseSheets);
          Object.assign(out.classSheets, r.classSheets);
        }
        return out;
      });
    }),

  /** A course's classes with their print overrides and sheets (the Layout inspector, Class view). */
  classOverrides: coursesViewProcedure
    .input(z.object({ courseId: z.number().int().positive() }))
    .query(async ({ ctx, input }): Promise<ClassOverrideRow[]> => {
      const rows = await ctx.db.class.findMany({
        where: { eventId: ctx.event.id, removed: false, course: { seq: input.courseId } },
        select: {
          seq: true,
          name: true,
          printScale: true,
          sheetTemplate: { select: { seq: true } },
          sheets: { select: { seq: true }, orderBy: [{ sortOrder: "asc" }, { seq: "asc" }] },
        },
        orderBy: [{ sortIndex: "asc" }, { seq: "asc" }],
      });
      return rows.map((r) => ({
        seq: r.seq,
        name: r.name,
        printScale: r.printScale,
        sheetTemplateSeq: r.sheetTemplate?.seq ?? null,
        sheets: r.sheets.map((s) => s.seq),
      }));
    }),

  /**
   * Set or clear a class's print override (`print_scale`, `sheet_template_id`;
   * null clears) and bring its course's class sheets in line (`autoSheets`).
   */
  setClassOverride: coursesEditProcedure
    .input(
      z.object({
        classId: z.number().int().positive(),
        printScale: z.number().int().min(500).max(100_000).nullable().optional(),
        sheetTemplateId: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<AutoSheetsResult | null> => {
      const cls = await ctx.db.class.findFirst({ where: { eventId: ctx.event.id, seq: input.classId, removed: false } });
      if (!cls) throw new TRPCError({ code: "NOT_FOUND", message: "Class not found" });
      const template =
        input.sheetTemplateId === undefined || input.sheetTemplateId === null
          ? null
          : await ctx.db.mapTemplate.findFirst({ where: { eventId: ctx.event.id, seq: input.sheetTemplateId }, select: { id: true } });
      if (input.sheetTemplateId && !template) throw new TRPCError({ code: "NOT_FOUND", message: "Map template not found" });
      return ctx.db.$transaction(async (tx) => {
        await tx.class.update({
          where: { id: cls.id },
          data: {
            ...(input.printScale !== undefined ? { printScale: input.printScale } : {}),
            ...(input.sheetTemplateId !== undefined ? { sheetTemplateId: template?.id ?? null } : {}),
          },
        });
        return cls.courseId ? autoSheets(tx, ctx.event.id, cls.courseId) : null;
      });
    }),
});
