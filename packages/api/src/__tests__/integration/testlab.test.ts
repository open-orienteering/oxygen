/**
 * Integration tests for the Test Lab simulator.
 *
 * Focus is on the end-to-end pipeline: build a tiny event by hand
 * (course + class + runner with start time + card), drive the
 * simulator in instant mode, and assert that the resulting `cards` +
 * `runners` rows look like what the kiosk / matcher would expect to
 * see from a real readout.
 *
 * Timed mode is exercised separately with `setTimeout`-free
 * progression so the suite stays fast.
 */

import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { createTestEvent, disconnect } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { appRouter } from "../../routers/index.js";
import { RunnerStatus } from "@oxygen/shared";

afterAll(async () => {
  await disconnect();
});

interface SimCtx {
  ctx: Awaited<ReturnType<typeof createTestEvent>>;
  caller: ReturnType<typeof makeCaller>;
}

/**
 * Build a tiny self-contained event: course with 3 controls, class
 * pointing at it, one runner with a draw start time + valid card.
 */
async function buildSimEvent(label: string): Promise<SimCtx> {
  const ctx = await createTestEvent(label);
  // The Test Lab works only on a test event (API-06).
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { isTestEvent: true } });
  const caller = makeCaller(ctx.event);

  const controls = await Promise.all([
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "31", name: "" },
    }),
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "32", name: "" },
    }),
    ctx.db.control.create({
      data: { eventId: ctx.eventId, codes: "33", name: "" },
    }),
  ]);

  const course = await ctx.db.course.create({
    data: {
      eventId: ctx.eventId,
      name: "H21",
      lengthM: 3000,
    },
  });
  await ctx.db.courseControl.createMany({
    data: controls.map((c, i) => ({
      courseId: course.id,
      controlId: c.id,
      position: i + 1,
    })),
  });

  const cls = await ctx.db.class.create({
    data: {
      eventId: ctx.eventId,
      name: "H21",
      courseId: course.id,
    },
  });

  // Start time 10:30:00 absolute → 21600 ds relative to zeroTime
  // (324000). The simulator picks this up via `startTime > 0`.
  await ctx.db.runner.create({
    data: {
      eventId: ctx.eventId,
      name: "Test Runner",
      classId: cls.id,
      cardNo: 999_001,
      startTime: 54000, // 10:30:00 abs = 54000 - 32400 zeroTime = 21600 rel
    },
  });

  return { ctx, caller };
}

describe("testLab simulator", () => {
  // Some sims hit Math.random — pin the seed-ish behaviour just enough
  // to avoid the rare anomaly outcome flipping an assertion.
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  it("instant-mode simulation processes all runners and writes a card", async () => {
    const f = await buildSimEvent("sim-instant");
    try {
      const result = await f.caller.testLab.startSimulation({
        speedFactor: 0,
        dnsRate: 0,
        dnfRate: 0,
        mpRate: 0,
      });
      expect(result.mode).toBe("instant");
      expect(result.processed).toBe(1);
      expect(result.total).toBe(1);

      const runner = await f.ctx.db.runner.findFirst({
        where: { eventId: f.ctx.eventId },
      });
      expect(runner?.status).toBe("ok");
      expect(runner?.finishTime).toBeGreaterThan(0);
      expect(runner?.cardId).not.toBeNull();

      const card = await f.ctx.db.card.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: 999_001 },
      });
      expect(card?.punchesRaw).toMatch(/^3-\d+\.\d;1-\d+\.\d;31-/);
      expect(card?.punchesRaw).toMatch(/2-\d+\.\d;$/);
    } finally {
      await f.caller.testLab.stopSimulation();
      await f.ctx.cleanup();
    }
  });

  it("rejects starting a sim with no eligible runners", async () => {
    const ctx = await createTestEvent("sim-empty");
    await ctx.db.event.update({ where: { id: ctx.eventId }, data: { isTestEvent: true } });
    const caller = makeCaller(ctx.event);
    try {
      await expect(
        caller.testLab.startSimulation({ speedFactor: 0 }),
      ).rejects.toThrow(/no runners/i);
    } finally {
      await ctx.cleanup();
    }
  });

  it("simulationStatus reflects active / inactive state", async () => {
    const f = await buildSimEvent("sim-status");
    try {
      // Inactive baseline.
      const before = await f.caller.testLab.simulationStatus();
      expect(before.active).toBe(false);
      expect(before.processed).toBe(0);

      await f.caller.testLab.startSimulation({
        speedFactor: 0,
        dnsRate: 0,
        dnfRate: 0,
        mpRate: 0,
      });
      // Instant mode finishes synchronously inside the mutation, so the
      // post-status should immediately reflect the absence of an
      // active timer.
      const after = await f.caller.testLab.simulationStatus();
      expect(after.active).toBe(false);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("generateReadout produces a valid synthetic card for a single runner", async () => {
    const f = await buildSimEvent("sim-single");
    try {
      const out = await f.caller.testLab.generateReadout({
        cardNo: 999_001,
      });
      expect(out.ok).toBe(true);
      expect(out.finishDs).toBeGreaterThan(0);
      expect(out.punchString).toMatch(/3-\d+\.\d;1-\d+\.\d;31-/);

      const runner = await f.ctx.db.runner.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: 999_001 },
      });
      // The single-shot generator always marks the runner OK; status
      // anomaly injection is reserved for the full simulator.
      expect(runner?.status).toBe("ok");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("generateReadout rejects an unknown card", async () => {
    const f = await buildSimEvent("sim-unknown");
    try {
      await expect(
        f.caller.testLab.generateReadout({ cardNo: 777_777 }),
      ).rejects.toThrow(/no runner/i);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("DNF anomaly produces a card without a finish punch", async () => {
    // Force dnfRate=1 so the single runner deterministically DNFs.
    const f = await buildSimEvent("sim-dnf");
    try {
      const result = await f.caller.testLab.startSimulation({
        speedFactor: 0,
        dnsRate: 0,
        dnfRate: 1,
        mpRate: 0,
      });
      expect(result.processed).toBe(1);

      const runner = await f.ctx.db.runner.findFirst({
        where: { eventId: f.ctx.eventId },
      });
      expect(runner?.status).toBe("dnf");
      expect(runner?.finishTime).toBe(0);

      const card = await f.ctx.db.card.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: 999_001 },
      });
      // DNF cards never contain the finish punch (type=2).
      expect(card?.punchesRaw).not.toMatch(/(^|;)2-/);
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("DNS anomaly skips the runner entirely", async () => {
    const f = await buildSimEvent("sim-dns");
    try {
      await f.caller.testLab.startSimulation({
        speedFactor: 0,
        dnsRate: 1,
        dnfRate: 0,
        mpRate: 0,
      });
      // No readout means no card row created.
      const card = await f.ctx.db.card.findFirst({
        where: { eventId: f.ctx.eventId, cardNo: 999_001 },
      });
      expect(card).toBeNull();
      // Runner status untouched → unknown.
      const runner = await f.ctx.db.runner.findFirst({
        where: { eventId: f.ctx.eventId },
      });
      expect(runner?.status).toBe("unknown");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("clearRunners wipes synthetic data without dropping the event", async () => {
    const f = await buildSimEvent("sim-clear");
    try {
      await f.caller.testLab.clearRunners();
      const count = await f.ctx.db.runner.count({
        where: { eventId: f.ctx.eventId },
      });
      expect(count).toBe(0);
      // The event itself + class + course should still exist.
      const cls = await f.ctx.db.class.count({
        where: { eventId: f.ctx.eventId },
      });
      expect(cls).toBeGreaterThan(0);
    } finally {
      await f.ctx.cleanup();
    }
  });
});

describe("test event guard (API-06)", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  /** A fixture event with the flag taken off again. */
  async function buildLiveEvent(label: string): Promise<SimCtx> {
    const f = await buildSimEvent(label);
    await f.ctx.db.event.update({ where: { id: f.ctx.eventId }, data: { isTestEvent: false } });
    return f;
  }

  async function counts(f: SimCtx) {
    const where = { eventId: f.ctx.eventId };
    return {
      runners: await f.ctx.db.runner.count({ where }),
      classes: await f.ctx.db.class.count({ where }),
      courses: await f.ctx.db.course.count({ where }),
      cards: await f.ctx.db.card.count({ where }),
      punches: await f.ctx.db.punch.count({ where }),
    };
  }

  it("refuses every writing procedure on a non-test event and changes nothing", async () => {
    const f = await buildLiveEvent("guard-live");
    try {
      const before = await counts(f);
      const classSeq = (await f.ctx.db.class.findFirstOrThrow({ where: { eventId: f.ctx.eventId } })).seq;
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["clearRunners", () => f.caller.testLab.clearRunners()],
        ["startSimulation", () => f.caller.testLab.startSimulation({ speedFactor: 0, dnsRate: 0, dnfRate: 0, mpRate: 0 })],
        ["updateSpeed", () => f.caller.testLab.updateSpeed({ speedFactor: 5 })],
        ["generateReadout", () => f.caller.testLab.generateReadout({ cardNo: 999_001 })],
        ["generateClasses", () => f.caller.testLab.generateClasses({ count: 3 })],
        ["generateCourses", () => f.caller.testLab.generateCourses({ count: 3 })],
        ["registerFictionalRunners", () => f.caller.testLab.registerFictionalRunners({ count: 5 })],
        ["registerRunners", () => f.caller.testLab.registerRunners({ classId: classSeq, count: 5 })],
        ["pushBackupPunch", () => f.caller.testLab.pushBackupPunch({ cardNo: 1, controlCode: 31, time: 1 })],
      ];
      for (const [name, call] of calls) {
        await expect(call(), name).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          message: expect.stringContaining("NOT_A_TEST_EVENT"),
        });
      }
      expect(await counts(f)).toEqual(before);
      const runner = await f.ctx.db.runner.findFirstOrThrow({ where: { eventId: f.ctx.eventId } });
      expect(runner.status).toBe("unknown");
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("leaves stopSimulation and the read-only procedures open on a non-test event", async () => {
    const f = await buildLiveEvent("guard-open");
    try {
      await expect(f.caller.testLab.stopSimulation()).resolves.toEqual({ ok: true });
      await expect(f.caller.testLab.status()).resolves.toMatchObject({ runnerCount: 1 });
      await expect(f.caller.testLab.simulationStatus()).resolves.toMatchObject({ active: false });
      await expect(f.caller.testLab.cardList()).resolves.toHaveLength(1);
      await expect(f.caller.testLab.listAllBackupPunches()).resolves.toEqual([]);
      await expect(f.caller.testLab.defaults()).resolves.toMatchObject({ runnerCount: 50 });
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("reads the flag fresh: turning it off refuses the next call", async () => {
    const f = await buildSimEvent("guard-fresh");
    try {
      await expect(f.caller.testLab.generateClasses({ count: 1 })).resolves.toMatchObject({ created: 1 });
      await f.caller.event.setTestEvent({ enabled: false });
      await expect(f.caller.testLab.generateClasses({ count: 1 })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    } finally {
      await f.ctx.cleanup();
    }
  });

  it("clearing the flag stops a timed simulation", async () => {
    const f = await buildSimEvent("guard-timer");
    try {
      const started = await f.caller.testLab.startSimulation({ speedFactor: 1, dnsRate: 0, dnfRate: 0, mpRate: 0 });
      expect(started.mode).toBe("timed");
      expect((await f.caller.testLab.simulationStatus()).active).toBe(true);
      await f.caller.event.setTestEvent({ enabled: false });
      expect((await f.caller.testLab.simulationStatus()).active).toBe(false);
    } finally {
      await f.caller.testLab.stopSimulation();
      await f.ctx.cleanup();
    }
  });

  it("a tick that finds the flag cleared in the database halts the timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await buildSimEvent("guard-tick");
    try {
      await f.caller.testLab.startSimulation({ speedFactor: 1, dnsRate: 0, dnfRate: 0, mpRate: 0 });
      // Raw update: no stopSimulationFor, the tick has to notice by itself.
      await f.ctx.db.event.update({ where: { id: f.ctx.eventId }, data: { isTestEvent: false } });
      await vi.advanceTimersByTimeAsync(1_200);
      await vi.waitFor(async () => {
        expect((await f.caller.testLab.simulationStatus()).active).toBe(false);
      });
    } finally {
      vi.useRealTimers();
      await f.caller.testLab.stopSimulation();
      await f.ctx.cleanup();
    }
  });

  it("generateEvent is gone (API-34)", () => {
    const procedures = appRouter._def.procedures as Record<string, unknown>;
    expect(procedures["testLab.generateEvent"]).toBeUndefined();
    expect(procedures["testLab.clearRunners"]).toBeDefined();
  });
});

// Avoid an unused-import warning when the file is partially elided in
// review; the constant documents the wire status value being asserted
// against the PG enum string.
void RunnerStatus.OK;
