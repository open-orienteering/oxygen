/**
 * `course.controlCompletionStatus` is polled every 15 s by the dashboard
 * and the map panel. These tests pin its counting rules so the query can
 * be narrowed (runners on the course only, cards those runners carry)
 * without changing what it reports:
 *
 *   - a runner belongs to a course directly (`runner.courseId`) or via
 *     its class (`class.courseId`), the direct assignment winning;
 *   - `passed` counts runners whose card holds any of the control's
 *     punch codes;
 *   - with no `courseId` every course in the event is aggregated.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let courseASeq: number;
let courseBSeq: number;

beforeAll(async () => {
  ctx = await createTestEvent("control_completion");
  caller = makeCaller(ctx.event);
  const db = ctx.db;
  const eventId = ctx.eventId;

  const c31 = await db.control.create({
    data: { eventId, codes: "31;131", xpos: 0, ypos: 0 },
    select: { id: true },
  });
  const c32 = await db.control.create({
    data: { eventId, codes: "32", xpos: 10, ypos: 0 },
    select: { id: true },
  });
  const c40 = await db.control.create({
    data: { eventId, codes: "40", xpos: 20, ypos: 0 },
    select: { id: true },
  });

  const courseA = await db.course.create({
    data: { eventId, name: "A", lengthM: 1000 },
    select: { id: true, seq: true },
  });
  const courseB = await db.course.create({
    data: { eventId, name: "B", lengthM: 1000 },
    select: { id: true, seq: true },
  });
  courseASeq = courseA.seq;
  courseBSeq = courseB.seq;
  await db.courseControl.createMany({
    data: [
      { courseId: courseA.id, position: 0, controlId: c31.id },
      { courseId: courseA.id, position: 1, controlId: c32.id },
      { courseId: courseB.id, position: 0, controlId: c40.id },
    ],
  });

  const classA = await db.class.create({
    data: { eventId, name: "H21", courseId: courseA.id },
    select: { id: true },
  });
  const classB = await db.class.create({
    data: { eventId, name: "D21", courseId: courseB.id },
    select: { id: true },
  });

  await db.runner.createMany({
    data: [
      // On A via class; punched 31 and 32.
      { eventId, name: "A via class, full", classId: classA.id, cardNo: 1001 },
      // On A via class; punched only the alternate code of control 31.
      { eventId, name: "A via class, alt code", classId: classA.id, cardNo: 1002 },
      // Class says B, but assigned directly to A; no card read yet.
      { eventId, name: "A direct", classId: classB.id, courseId: courseA.id, cardNo: 1003 },
      // On B via class; punched 40.
      { eventId, name: "B via class", classId: classB.id, cardNo: 2001 },
      // Removed runner on A — must not count.
      { eventId, name: "A removed", classId: classA.id, cardNo: 1004, removed: true },
      // No class at all — never counted (matches the dashboard's rule).
      { eventId, name: "unclassed", courseId: courseA.id, cardNo: 1005 },
    ],
  });
  await db.card.createMany({
    data: [
      { eventId, cardNo: 1001, punchesRaw: "31-100.0;32-200.0" },
      { eventId, cardNo: 1002, punchesRaw: "131-100.0" },
      { eventId, cardNo: 1004, punchesRaw: "31-100.0;32-200.0" },
      { eventId, cardNo: 1005, punchesRaw: "31-100.0;32-200.0" },
      { eventId, cardNo: 2001, punchesRaw: "40-300.0" },
      // A card nobody on this event carries: must not influence anything.
      { eventId, cardNo: 9999, punchesRaw: "31-1.0;32-1.0;40-1.0" },
    ],
  });
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  await disconnect();
}, 30_000);

const byCode = (rows: Array<{ code: number; total: number; passed: number }>) =>
  Object.fromEntries(rows.map((r) => [r.code, { total: r.total, passed: r.passed }]));

describe("course.controlCompletionStatus", () => {
  it("scoped to a course counts only that course's runners and their cards", async () => {
    const rows = byCode(
      await caller.course.controlCompletionStatus({ courseId: courseASeq }),
    );
    // Three live, classed runners on A: two via class, one direct.
    expect(rows[31]).toEqual({ total: 3, passed: 2 }); // 31 or 131
    expect(rows[32]).toEqual({ total: 3, passed: 1 });
    expect(rows[40]).toBeUndefined();
  });

  it("a runner's direct course assignment overrides the class course", async () => {
    const rows = byCode(
      await caller.course.controlCompletionStatus({ courseId: courseBSeq }),
    );
    // "A direct" is in class D21 (→ B) but assigned to A, so B has one runner.
    expect(rows[40]).toEqual({ total: 1, passed: 1 });
  });

  it("without a course aggregates every course in the event", async () => {
    const rows = byCode(await caller.course.controlCompletionStatus());
    expect(rows[31]).toEqual({ total: 3, passed: 2 });
    expect(rows[32]).toEqual({ total: 3, passed: 1 });
    expect(rows[40]).toEqual({ total: 1, passed: 1 });
  });
});
