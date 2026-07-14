/**
 * Test Lab — synthetic event + real-time race simulator.
 *
 * The "scaffolding" half (generateClasses / generateCourses /
 * registerFictionalRunners / etc) creates the static structure of a
 * fake event. The "simulator" half (startSimulation / generateReadout)
 * picks up runners that have a start time and a course, generates
 * MeOS-format punch strings on a configurable speed multiplier and
 * writes them back into `cards` + `runners` so the rest of the system
 * (kiosk, splits, results) sees a realistic race unfolding.
 *
 * Anomaly injection is intentionally simple: per-runner dice rolls for
 * DNS / DNF / MissingPunch. The shape is enough to exercise the
 * matcher's "did this runner cleanly complete the course?" branches
 * without needing the legacy fault-injection knobs.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure, publicProcedure } from "../trpc.js";
import { sanitizeNameId, prisma } from "../db.js";
import {
  MALE_FIRST_NAMES,
  FEMALE_FIRST_NAMES,
  LAST_NAMES,
  CLUBS as CLUB_DATA,
} from "./fictional-names.js";
import { valueToRunnerStatus } from "../statusConvert.js";
import { RunnerStatus } from "@oxygen/shared";
import { toRelative } from "../timeConvert.js";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function gaussianRandom(): number {
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Class name → course pace tier (seconds per km, with spread). Falls
// back to tier 4 (mid-pack adult) when the class name doesn't match a
// known pattern.
const TIER_PACE: Record<number, { base: number; spread: number }> = {
  1: { base: 600, spread: 0.25 },
  2: { base: 540, spread: 0.22 },
  3: { base: 480, spread: 0.2 },
  4: { base: 440, spread: 0.18 },
  5: { base: 400, spread: 0.17 },
  6: { base: 370, spread: 0.16 },
  7: { base: 350, spread: 0.15 },
  8: { base: 330, spread: 0.15 },
};

function tierForClassName(name: string): number {
  if (/H21|D21/.test(name)) return /H21/.test(name) ? 8 : 7;
  if (/H2[03]|H1[89]/.test(name)) return 6;
  if (/D2[03]|D1[89]/.test(name)) return 5;
  if (/H1[67]/.test(name)) return 4;
  if (/D1[67]/.test(name)) return 4;
  if (/H1[45]|D1[45]/.test(name)) return 3;
  if (/H1[23]|D1[23]/.test(name)) return 2;
  if (/H1[01]|D1[01]/.test(name)) return 1;
  const m = name.match(/^[HD](\d{2,3})$/);
  if (m) {
    const age = parseInt(m[1], 10);
    if (age >= 70) return 2;
    if (age >= 50) return 4;
    if (age >= 35) return 5;
  }
  return 4;
}

/**
 * Build a MeOS-format punch string (`type-s.t;type-s.t;...`). The card
 * column expects this exact shape — the matcher's `parsePunches`
 * round-trips it.
 *
 *   Type 1 = start
 *   Type 2 = finish
 *   Type 3 = check
 *   Type ≥30 = regular control code
 *
 * Times are absolute deciseconds (matches the kiosk-readout contract).
 */
function buildMeosPunchString(opts: {
  checkTimeDs?: number;
  startTimeDs: number;
  controlPunches: { code: number; timeDs: number }[];
  finishTimeDs?: number;
}): string {
  const parts: string[] = [];
  const fmt = (type: number, ds: number) =>
    `${type}-${Math.floor(ds / 10)}.${ds % 10}`;
  if (opts.checkTimeDs && opts.checkTimeDs > 0)
    parts.push(fmt(3, opts.checkTimeDs));
  if (opts.startTimeDs > 0) parts.push(fmt(1, opts.startTimeDs));
  for (const p of opts.controlPunches) parts.push(fmt(p.code, p.timeDs));
  if (opts.finishTimeDs && opts.finishTimeDs > 0)
    parts.push(fmt(2, opts.finishTimeDs));
  return parts.length > 0 ? parts.join(";") + ";" : "";
}

interface SimulatedReadout {
  runnerId: string;
  cardNo: number;
  finishTimeDs: number; // absolute deciseconds — when readout triggers
  punchString: string;
  status: number; // RunnerStatusValue
  finishDs: number; // absolute deciseconds finish time (0 = DNF)
}

interface SimulationState {
  running: boolean;
  timer: NodeJS.Timeout | null;
  schedule: SimulatedReadout[];
  processed: number;
  total: number;
  startedAtReal: number;
  speedMultiplier: number;
  simTimeAtLastSpeedChange: number;
  realTimeAtLastSpeedChange: number;
  eventId: bigint;
  zeroTime: number;
}

const simulations = new Map<string, SimulationState>();

/**
 * Insert / update the synthetic card + link it to the runner.
 *
 * - Card row uses MeOS-format `punches_raw` (same string the real
 *   readout writes) so the matcher and kiosk see realistic data.
 * - Runner `finishTime` / `status` are updated; status int is
 *   translated to the PG enum string via `valueToRunnerStatus`.
 */
async function processSimulatedReadout(
  eventId: bigint,
  zeroTime: number,
  readout: SimulatedReadout,
): Promise<void> {
  const db = prisma();
  const existing = await db.card.findFirst({
    where: { eventId, cardNo: readout.cardNo },
    select: { id: true },
  });
  let cardId: string;
  if (existing) {
    await db.card.update({
      where: { id: existing.id },
      data: { punchesRaw: readout.punchString, removed: false },
    });
    cardId = existing.id;
  } else {
    const card = await db.card.create({
      data: {
        eventId,
        cardNo: readout.cardNo,
        punchesRaw: readout.punchString,
      },
      select: { id: true },
    });
    cardId = card.id;
  }

  await db.runner.update({
    where: { id: readout.runnerId },
    data: {
      cardId,
      finishTime:
        readout.finishDs > 0 ? toRelative(readout.finishDs, zeroTime) : 0,
      status: valueToRunnerStatus(readout.status),
    },
  });
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

  // ─── Test Lab UI surface ────────────────────────────────
  // Counts + simulator status used by the TestLabPage header. The
  // simulation pipeline itself lives further down (`startSimulation`,
  // `simulationStatus`, `updateSpeed`, `stopSimulation`).

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

  /**
   * Start a real-time race simulation.
   *
   * - `speedFactor` 0 = instant: every readout is processed immediately.
   * - `speedFactor` N>0 = sim time advances N× wall time. Each 500ms
   *   tick processes every readout whose `finishTimeDs` has been reached.
   *
   * Pre-conditions: at least one runner with `startTime > 0`, a course
   * (either on the runner or via the class), and a valid `cardNo`. The
   * draw + course assignment are normally done from the EventPage
   * before pressing "Start simulation".
   */
  startSimulation: eventProcedure
    .input(
      z
        .object({
          speedFactor: z.number().min(0).default(10),
          // Anomaly knobs — leaving these on the input makes it cheap
          // to run targeted "no anomalies" sims for screenshots.
          dnsRate: z.number().min(0).max(1).default(0.02),
          dnfRate: z.number().min(0).max(1).default(0.05),
          mpRate: z.number().min(0).max(1).default(0.03),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const key = String(ctx.event.id);
      const existing = simulations.get(key);
      if (existing?.running) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Simulation already running. Stop it first.",
        });
      }

      const cfg = {
        speedFactor: input?.speedFactor ?? 10,
        dnsRate: input?.dnsRate ?? 0.02,
        dnfRate: input?.dnfRate ?? 0.05,
        mpRate: input?.mpRate ?? 0.03,
      };

      const event = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: { zeroTime: true },
      });
      const zeroTime = event?.zeroTime ?? 324000;

      const runners = await ctx.db.runner.findMany({
        where: {
          eventId: ctx.event.id,
          removed: false,
          startTime: { gt: 0 },
          cardNo: { gt: 0 },
        },
        select: {
          id: true,
          cardNo: true,
          startTime: true,
          classId: true,
          courseId: true,
          class: { select: { name: true, courseId: true } },
        },
      });
      if (runners.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No runners with start times + SI cards found. Draw start times first.",
        });
      }

      // Pre-load every course's control sequence so we can synth
      // punches without N round-trips.
      const courseIds = new Set<string>();
      for (const r of runners) {
        const cid = r.courseId ?? r.class?.courseId ?? null;
        if (cid) courseIds.add(cid);
      }
      const courseRows = await ctx.db.course.findMany({
        where: { id: { in: [...courseIds] } },
        select: {
          id: true,
          lengthM: true,
          courseControls: {
            orderBy: { position: "asc" },
            select: { control: { select: { codes: true } } },
          },
        },
      });
      const courseById = new Map(
        courseRows.map((c) => {
          const codes: number[] = [];
          for (const cc of c.courseControls) {
            const first = parseInt(
              (cc.control.codes ?? "").split(";")[0] ?? "",
              10,
            );
            if (Number.isFinite(first) && first >= 30) codes.push(first);
          }
          return [c.id, { lengthM: c.lengthM ?? 5000, codes }];
        }),
      );

      // Build the schedule of synthetic readouts.
      const schedule: SimulatedReadout[] = [];
      for (const r of runners) {
        if (Math.random() < cfg.dnsRate) continue;

        const courseId = r.courseId ?? r.class?.courseId ?? null;
        const course = courseId ? courseById.get(courseId) : undefined;
        if (!course || course.codes.length === 0) continue;

        const tier = tierForClassName(r.class?.name ?? "");
        const pace = TIER_PACE[tier] ?? TIER_PACE[4];

        const courseLengthKm = course.lengthM / 1000;
        const paceVariation = 1 + gaussianRandom() * pace.spread;
        const totalSeconds = Math.max(
          courseLengthKm * pace.base * 0.5,
          courseLengthKm * pace.base * paceVariation,
        );

        const isDNF = Math.random() < cfg.dnfRate;
        const isMP = !isDNF && Math.random() < cfg.mpRate;
        const mpIdx = isMP
          ? Math.floor(Math.random() * course.codes.length)
          : -1;

        // `startTime` storage is ZeroTime-relative; the simulator
        // schedule works in absolute deciseconds because that's what
        // the readout pipeline contracts on.
        const startAbsoluteDs = r.startTime + zeroTime;
        const checkAbsoluteDs = startAbsoluteDs - 600; // 1 min before start

        const numLegs = course.codes.length + 1;
        const legs: number[] = [];
        let legSum = 0;
        for (let i = 0; i < numLegs; i++) {
          const raw = Math.max(0.3, 1 + gaussianRandom() * 0.3);
          legs.push(raw);
          legSum += raw;
        }
        const scale = totalSeconds / legSum;
        for (let i = 0; i < legs.length; i++) legs[i] *= scale;

        const punches: { code: number; timeDs: number }[] = [];
        let cumulative = startAbsoluteDs;
        const codesToVisit = isDNF
          ? course.codes.slice(
              0,
              Math.floor(
                course.codes.length * (0.3 + Math.random() * 0.5),
              ),
            )
          : course.codes;
        for (let i = 0; i < codesToVisit.length; i++) {
          cumulative += Math.round(legs[i] * 10);
          if (isMP && i === mpIdx) continue;
          punches.push({ code: codesToVisit[i], timeDs: cumulative });
        }

        let finishDs = 0;
        if (!isDNF) {
          cumulative += Math.round(legs[legs.length - 1] * 10);
          finishDs = cumulative;
        }

        const punchString = buildMeosPunchString({
          checkTimeDs: checkAbsoluteDs,
          startTimeDs: startAbsoluteDs,
          controlPunches: punches,
          finishTimeDs: finishDs > 0 ? finishDs : undefined,
        });

        const status = isDNF
          ? RunnerStatus.DNF
          : isMP
            ? RunnerStatus.MissingPunch
            : RunnerStatus.OK;

        schedule.push({
          runnerId: r.id,
          cardNo: r.cardNo ?? 0,
          finishTimeDs: finishDs > 0 ? finishDs : cumulative,
          punchString,
          status,
          finishDs,
        });
      }

      schedule.sort((a, b) => a.finishTimeDs - b.finishTimeDs);

      // Instant mode — process everything inline and return.
      if (cfg.speedFactor === 0) {
        for (const r of schedule) {
          try {
            await processSimulatedReadout(ctx.event.id, zeroTime, r);
          } catch (err) {
            console.error("[testLab] readout failed:", err);
          }
        }
        return {
          mode: "instant" as const,
          processed: schedule.length,
          total: schedule.length,
        };
      }

      const earliestStart = Math.min(
        ...runners.map((r) => r.startTime + zeroTime),
      );
      const now = Date.now();
      const state: SimulationState = {
        running: true,
        timer: null,
        schedule,
        processed: 0,
        total: schedule.length,
        startedAtReal: now,
        speedMultiplier: cfg.speedFactor,
        simTimeAtLastSpeedChange: earliestStart,
        realTimeAtLastSpeedChange: now,
        eventId: ctx.event.id,
        zeroTime,
      };

      // 500ms tick — sized to balance wall-clock granularity against
      // DB write pressure when speedFactor is high.
      const tick = async () => {
        if (!state.running || state.processed >= state.total) {
          if (state.timer) clearInterval(state.timer);
          state.running = false;
          return;
        }
        const elapsedRealMs = Date.now() - state.realTimeAtLastSpeedChange;
        const elapsedSimDs = Math.floor(
          (elapsedRealMs / 100) * state.speedMultiplier,
        );
        const currentSimTime = state.simTimeAtLastSpeedChange + elapsedSimDs;

        while (
          state.processed < state.total &&
          state.schedule[state.processed].finishTimeDs <= currentSimTime
        ) {
          try {
            await processSimulatedReadout(
              state.eventId,
              state.zeroTime,
              state.schedule[state.processed],
            );
          } catch (err) {
            console.error("[testLab] readout failed:", err);
          }
          state.processed++;
        }

        if (state.processed >= state.total) {
          if (state.timer) clearInterval(state.timer);
          state.running = false;
        }
      };

      state.timer = setInterval(tick, 500);
      simulations.set(key, state);

      return {
        mode: "timed" as const,
        processed: 0,
        total: schedule.length,
      };
    }),

  stopSimulation: eventProcedure.mutation(async ({ ctx }) => {
    const key = String(ctx.event.id);
    const state = simulations.get(key);
    if (state?.timer) clearInterval(state.timer);
    if (state) state.running = false;
    simulations.delete(key);
    return { ok: true as const };
  }),

  simulationStatus: eventProcedure.query(async ({ ctx }) => {
    const state = simulations.get(String(ctx.event.id));
    if (!state) {
      return {
        active: false,
        progress: 0,
        processed: 0,
        total: 0,
        speedFactor: 1,
        elapsedMs: 0,
      };
    }
    return {
      active: state.running,
      progress: state.total > 0 ? state.processed / state.total : 0,
      processed: state.processed,
      total: state.total,
      speedFactor: state.speedMultiplier,
      elapsedMs: Date.now() - state.startedAtReal,
    };
  }),

  updateSpeed: eventProcedure
    .input(z.object({ speedFactor: z.number().positive() }))
    .mutation(async ({ ctx, input }) => {
      const state = simulations.get(String(ctx.event.id));
      if (!state?.running) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No simulation running.",
        });
      }
      // Preserve the simulated time across a speed change so progress
      // doesn't jump on the next tick.
      const now = Date.now();
      const elapsedRealMs = now - state.realTimeAtLastSpeedChange;
      const elapsedSimDs = Math.floor(
        (elapsedRealMs / 100) * state.speedMultiplier,
      );
      state.simTimeAtLastSpeedChange += elapsedSimDs;
      state.realTimeAtLastSpeedChange = now;
      state.speedMultiplier = input.speedFactor;
      return { ok: true as const, speedFactor: input.speedFactor };
    }),

  cardList: eventProcedure.query(async ({ ctx }) => {
    const runners = await ctx.db.runner.findMany({
      where: { eventId: ctx.event.id, removed: false, cardNo: { gt: 0 } },
      select: { cardNo: true, name: true, seq: true },
      take: 200,
    });
    return runners.map((r) => ({ id: r.seq, name: r.name, cardNo: r.cardNo }));
  }),

  /**
   * Generate a single synthetic readout for the given card. Useful for
   * debugging kiosk / receipt flows without having to spin up the full
   * simulator. Returns the resulting `runner.id` + `finishTime` so a
   * test can immediately assert on the after-state.
   */
  generateReadout: eventProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: {
          eventId: ctx.event.id,
          cardNo: input.cardNo,
          removed: false,
        },
        select: {
          id: true,
          startTime: true,
          courseId: true,
          class: { select: { name: true, courseId: true } },
        },
      });
      if (!runner) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No runner with card ${input.cardNo}.`,
        });
      }
      const courseId = runner.courseId ?? runner.class?.courseId ?? null;
      if (!courseId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Runner has no assigned course.",
        });
      }
      const course = await ctx.db.course.findUnique({
        where: { id: courseId },
        select: {
          lengthM: true,
          courseControls: {
            orderBy: { position: "asc" },
            select: { control: { select: { codes: true } } },
          },
        },
      });
      if (!course) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Course missing." });
      }
      const codes: number[] = [];
      for (const cc of course.courseControls) {
        const first = parseInt(
          (cc.control.codes ?? "").split(";")[0] ?? "",
          10,
        );
        if (Number.isFinite(first) && first >= 30) codes.push(first);
      }
      if (codes.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Course has no controls.",
        });
      }

      const event = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: { zeroTime: true },
      });
      const zeroTime = event?.zeroTime ?? 324000;

      const tier = tierForClassName(runner.class?.name ?? "");
      const pace = TIER_PACE[tier] ?? TIER_PACE[4];
      const totalSeconds =
        ((course.lengthM ?? 5000) / 1000) *
        pace.base *
        Math.max(0.5, 1 + gaussianRandom() * pace.spread);

      const startAbsolute =
        runner.startTime > 0 ? runner.startTime + zeroTime : 36000 + zeroTime; // fallback 10:00
      let cumulative = startAbsolute;
      const punches: { code: number; timeDs: number }[] = [];
      const numLegs = codes.length + 1;
      const baseLegSeconds = totalSeconds / numLegs;
      for (let i = 0; i < codes.length; i++) {
        cumulative += Math.round(
          baseLegSeconds * 10 * Math.max(0.3, 1 + gaussianRandom() * 0.2),
        );
        punches.push({ code: codes[i], timeDs: cumulative });
      }
      cumulative += Math.round(baseLegSeconds * 10);
      const finishDs = cumulative;

      const punchString = buildMeosPunchString({
        checkTimeDs: startAbsolute - 600,
        startTimeDs: startAbsolute,
        controlPunches: punches,
        finishTimeDs: finishDs,
      });

      await processSimulatedReadout(ctx.event.id, zeroTime, {
        runnerId: runner.id,
        cardNo: input.cardNo,
        finishTimeDs: finishDs,
        punchString,
        status: RunnerStatus.OK,
        finishDs,
      });

      return {
        ok: true as const,
        runnerId: runner.id,
        finishDs,
        punchString,
      };
    }),

  /** Generate a starter set of classes for the event. */
  generateClasses: eventProcedure
    .input(z.object({ count: z.number().int().min(1).max(20).default(5) }).optional())
    .mutation(async ({ ctx, input }) => {
      const count = input?.count ?? 5;
      const names = ["H21", "D21", "H17", "D17", "H45", "D45", "H10", "D10", "Öppen 1", "Öppen 2"];
      let created = 0;
      for (let i = 0; i < Math.min(count, names.length); i++) {
        try {
          await ctx.db.class.create({
            data: {
              eventId: ctx.event.id,
              name: names[i],
              sortIndex: i,
            },
          });
          created++;
        } catch {
          // class might already exist
        }
      }
      return { created };
    }),

  /** Generate a starter set of courses. */
  generateCourses: eventProcedure
    .input(z.object({ count: z.number().int().min(1).max(20).default(3) }).optional())
    .mutation(async ({ ctx, input }) => {
      const count = input?.count ?? 3;
      const lengths = [2500, 4500, 7500, 9500, 12000];
      let created = 0;
      for (let i = 0; i < Math.min(count, lengths.length); i++) {
        try {
          await ctx.db.course.create({
            data: {
              eventId: ctx.event.id,
              name: `Course ${String.fromCharCode(65 + i)}`,
              lengthM: lengths[i],
            },
          });
          created++;
        } catch {
          // already exists
        }
      }
      return { created };
    }),

  /** Register N fictional runners. */
  registerFictionalRunners: eventProcedure
    .input(z.object({ count: z.number().int().min(1).max(2000).default(20) }))
    .mutation(async ({ ctx, input }) => {
      const classes = await ctx.db.class.findMany({
        where: { eventId: ctx.event.id, removed: false },
        select: { id: true },
      });
      if (classes.length === 0) {
        return { created: 0, message: "No classes — call generateClasses first." };
      }
      let created = 0;
      for (let i = 0; i < input.count; i++) {
        const male = Math.random() < 0.5;
        const first = pick(male ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES);
        const last = pick(LAST_NAMES);
        const cls = pick(classes);
        try {
          await ctx.db.runner.create({
            data: {
              eventId: ctx.event.id,
              name: `${first} ${last}`,
              classId: cls.id,
              clubName: pick(CLUB_DATA).name,
              cardNo: 100000 + Math.floor(Math.random() * 9_000_000),
              sex: male ? "M" : "F",
              birthYear: 1960 + Math.floor(Math.random() * 50),
            },
          });
          created++;
        } catch {
          // unique constraint, skip
        }
      }
      return { created };
    }),

  /** Register N runners onto a specific class. */
  registerRunners: eventProcedure
    .input(
      z.object({
        classId: z.number().int(),
        count: z.number().int().min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cls = await ctx.db.class.findFirst({
        where: { eventId: ctx.event.id, seq: input.classId, removed: false },
        select: { id: true },
      });
      if (!cls) return { created: 0 };
      let created = 0;
      for (let i = 0; i < input.count; i++) {
        const male = Math.random() < 0.5;
        const first = pick(male ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES);
        const last = pick(LAST_NAMES);
        try {
          await ctx.db.runner.create({
            data: {
              eventId: ctx.event.id,
              name: `${first} ${last}`,
              classId: cls.id,
              clubName: pick(CLUB_DATA).name,
              cardNo: 100000 + Math.floor(Math.random() * 9_000_000),
              sex: male ? "M" : "F",
            },
          });
          created++;
        } catch {
          // skip
        }
      }
      return { created };
    }),

  /** Push a synthetic backup-memory punch. */
  pushBackupPunch: eventProcedure
    .input(
      z.object({
        cardNo: z.number().int(),
        controlCode: z.number().int(),
        time: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.punch.create({
        data: {
          eventId: ctx.event.id,
          cardNo: input.cardNo,
          controlCode: input.controlCode,
          time: input.time,
          source: "backup_memory",
        },
      });
      return { ok: true as const };
    }),

  /** List all backup-memory punches for the event. */
  listAllBackupPunches: eventProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.punch.findMany({
      where: {
        eventId: ctx.event.id,
        source: "backup_memory",
        removed: false,
      },
      orderBy: { importedAt: "desc" },
      take: 1000,
    });
    return rows.map((p) => ({
      id: p.id,
      cardNo: p.cardNo,
      controlCode: p.controlCode,
      time: p.time,
      importedAt: p.importedAt.toISOString(),
    }));
  }),
});
