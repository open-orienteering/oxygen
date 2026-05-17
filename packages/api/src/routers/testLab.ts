/**
 * Test Lab — minimal port. The full simulator (real-time race playback,
 * sophisticated split-time generation, anomalies) is being re-implemented
 * against the new schema. This stub just creates an empty event with a
 * couple of classes / runners so the web Test Lab page renders end-to-end.
 */

import { z } from "zod";
import { router, eventProcedure, publicProcedure } from "../trpc.js";
import { sanitizeNameId, prisma } from "../db.js";
import {
  MALE_FIRST_NAMES,
  FEMALE_FIRST_NAMES,
  LAST_NAMES,
  CLUBS as CLUB_DATA,
} from "./fictional-names.js";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const testLabRouter = router({
  generateEvent: publicProcedure
    .input(
      z.object({
        name: z.string().default("Test Lab"),
        runnerCount: z.number().int().min(1).max(2000).default(50),
      }),
    )
    .mutation(async ({ input }) => {
      const slug = sanitizeNameId(`E2E_${input.name}_${Date.now()}`);
      const event = await prisma().event.create({
        data: {
          nameId: slug,
          name: input.name,
          date: new Date(),
          kind: "competition",
        },
      });

      // Three classes, three courses
      const courses = await Promise.all(
        ["Short", "Medium", "Long"].map((n) =>
          prisma().course.create({
            data: { eventId: event.id, name: n, lengthM: 2000 + Math.random() * 5000 },
            select: { id: true, seq: true, name: true },
          }),
        ),
      );
      const classes = await Promise.all(
        courses.map((c) =>
          prisma().class.create({
            data: { eventId: event.id, name: c.name, courseId: c.id, sortIndex: c.seq },
            select: { id: true, seq: true },
          }),
        ),
      );

      // Generate runners
      const runners: { id: string }[] = [];
      for (let i = 0; i < input.runnerCount; i++) {
        const male = Math.random() < 0.5;
        const first = pick(male ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES);
        const last = pick(LAST_NAMES);
        const cls = pick(classes);
        const r = await prisma().runner.create({
          data: {
            eventId: event.id,
            name: `${first} ${last}`,
            cardNo: 100000 + i,
            clubName: pick(CLUB_DATA).name,
            classId: cls.id,
            sex: male ? "M" : "F",
          },
          select: { id: true },
        });
        runners.push(r);
      }

      return { nameId: event.nameId, runnerCount: runners.length };
    }),

  /** Delete every runner for the active event. */
  clearRunners: eventProcedure.mutation(async ({ ctx }) => {
    const result = await ctx.db.runner.deleteMany({
      where: { eventId: ctx.event.id },
    });
    return { deleted: result.count };
  }),

  // ─── Stubs for the Test Lab UI ──────────────────────────
  // The real simulation pipeline is being re-ported against the new
  // schema. Until then these stubs let the page render without errors.

  status: eventProcedure.query(async ({ ctx }) => {
    const runnerCount = await ctx.db.runner.count({
      where: { eventId: ctx.event.id, removed: false },
    });
    const classCount = await ctx.db.class.count({
      where: { eventId: ctx.event.id, removed: false },
    });
    const courseCount = await ctx.db.course.count({
      where: { eventId: ctx.event.id, removed: false },
    });
    return {
      runnerCount,
      classCount,
      courseCount,
      simulationActive: false,
    };
  }),

  defaults: publicProcedure.query(() => ({
    runnerCount: 50,
    classCount: 3,
    courseCount: 3,
    speedFactor: 1,
  })),

  startSimulation: eventProcedure
    .input(z.object({ speedFactor: z.number().positive().default(1) }))
    .mutation(async () => ({ ok: true as const, message: "Simulation pipeline pending re-port." })),

  stopSimulation: eventProcedure.mutation(async () => ({ ok: true as const })),

  simulationStatus: eventProcedure.query(async () => ({
    active: false,
    progress: 0,
    speedFactor: 1,
  })),

  updateSpeed: eventProcedure
    .input(z.object({ speedFactor: z.number().positive() }))
    .mutation(async () => ({ ok: true as const })),

  cardList: eventProcedure.query(async ({ ctx }) => {
    const runners = await ctx.db.runner.findMany({
      where: { eventId: ctx.event.id, removed: false, cardNo: { gt: 0 } },
      select: { cardNo: true, name: true, seq: true },
      take: 200,
    });
    return runners.map((r) => ({ id: r.seq, name: r.name, cardNo: r.cardNo }));
  }),

  generateReadout: eventProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .mutation(async () => ({ ok: true as const, message: "Readout simulator pending re-port." })),
});
