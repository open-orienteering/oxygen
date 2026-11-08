/**
 * Templates by key, sheets and class overrides (docs/course-layout.md §5–§6;
 * research 08 §4.4, §4.6, §6 `layout.autoSheets`). Layout data is
 * cloud-owned and not journaled (08 §4.8); the class override columns are
 * left out of `class.upserted` (`referenceJournal.ts`).
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  autoSheets,
  ensureAllControlsSheet,
  MAX_SETTER_GROUPS,
  moveToSetter,
  recalculateSheet,
  setterMaps,
  type AutoSheetsResult,
  type RecalculatedSheet,
  type SetterMapsResult,
} from "../course-maps/auto-sheets.js";
import { coursesEditProcedure, coursesViewProcedure, router } from "../trpc.js";

/** "All courses" on a large event creates many sheets in one transaction: more than Prisma's 5 s default. */
const AUTO_SHEETS_TX = { timeout: 60_000, maxWait: 10_000 };

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
   * course of the event (Export ▾ "all courses"). `allControls: true` also
   * ensures the event's all-controls sheet (`ensureAllControlsSheet`);
   * alone (`{ allControls: true }`) it runs only that part. Idempotent.
   */
  autoSheets: coursesEditProcedure
    .input(z.object({ courseId: z.number().int().positive().optional(), allControls: z.boolean().optional() }))
    .mutation(async ({ ctx, input }): Promise<AutoSheetsResult> => {
      const onlyAllControls = input.allControls === true && input.courseId === undefined;
      const courses = onlyAllControls
        ? []
        : await ctx.db.course.findMany({
            where: { eventId: ctx.event.id, removed: false, ...(input.courseId !== undefined ? { seq: input.courseId } : {}) },
            select: { id: true },
            orderBy: { seq: "asc" },
          });
      if (input.courseId !== undefined && courses.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      return ctx.db.$transaction(async (tx) => {
        const out: AutoSheetsResult = { createdSheets: [], createdTemplates: [], courseSheets: [], classSheets: {}, allControlsSheet: null };
        for (const c of courses) {
          const r = await autoSheets(tx, ctx.event.id, c.id);
          out.createdSheets.push(...r.createdSheets);
          out.createdTemplates.push(...r.createdTemplates);
          out.courseSheets.push(...r.courseSheets);
          Object.assign(out.classSheets, r.classSheets);
        }
        if (input.allControls) {
          const a = await ensureAllControlsSheet(tx, ctx.event.id);
          out.allControlsSheet = a.sheet;
          if (a.createdSheet) out.createdSheets.push(a.sheet);
          if (a.createdTemplate !== null && !out.createdTemplates.includes(a.createdTemplate)) out.createdTemplates.push(a.createdTemplate);
        }
        return out;
      }, AUTO_SHEETS_TX);
    }),

  /**
   * Setter maps (docs/course-layout.md §8; 08 §4.6, §6 `layout.setterMaps`):
   * the scope's — the event's, or with `courseId` that course's — setter
   * sheets replaced by `groups` sheets of geographically grouped controls,
   * each on the A4 auto template fitted to its group. Regenerating replaces
   * them (edits on the old ones are lost).
   */
  setterMaps: coursesEditProcedure
    .input(z.object({ courseId: z.number().int().positive().optional(), groups: z.number().int().min(1).max(MAX_SETTER_GROUPS) }))
    .mutation(async ({ ctx, input }): Promise<SetterMapsResult> => {
      const course =
        input.courseId === undefined
          ? null
          : await ctx.db.course.findFirst({ where: { eventId: ctx.event.id, seq: input.courseId, removed: false }, select: { id: true } });
      if (input.courseId !== undefined && !course) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
      return ctx.db.$transaction((tx) => setterMaps(tx, ctx.event.id, { courseUuid: course?.id ?? null, groups: input.groups }), AUTO_SHEETS_TX);
    }),

  /** *Move to next setter* (§8): the control (seq) leaves its setter map of `sheet`'s scope for `sheet`; windows stay. */
  moveToSetter: coursesEditProcedure
    .input(z.object({ controlId: z.number().int().positive(), sheet: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction((tx) => moveToSetter(tx, ctx.event.id, { controlSeq: input.controlId, sheetSeq: input.sheet })),
    ),

  /** *Recalculate* (§6, §8): an all-controls or setter sheet refitted — scale, orientation, centred window, the block's position. */
  recalculateSheet: coursesEditProcedure
    .input(z.object({ sheet: z.number().int().positive() }))
    .mutation(async ({ ctx, input }): Promise<RecalculatedSheet> =>
      ctx.db.$transaction((tx) => recalculateSheet(tx, ctx.event.id, input.sheet)),
    ),

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
      }, AUTO_SHEETS_TX);
    }),
});
