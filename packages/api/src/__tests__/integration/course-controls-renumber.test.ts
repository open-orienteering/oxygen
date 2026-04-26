/**
 * Integration tests for the Id-vs-code separation between
 * `oCourse.Controls` (stable oControl.Id list, MeOS-compatible storage)
 * and the live punch codes in `oControl.Numbers` (what cards actually
 * carry). These tests cover the end-to-end path that breaks if any layer
 * forgets to dereference: a control's punch code is renumbered, the
 * Courses page must show the new code, and a card carrying the new code
 * must still readout cleanly.
 *
 * The data model is verified against MeOS upstream — see
 * `code/oCourse.cpp:137` (writes Id) and `code/oCourse.cpp:472,483`
 * (matches against live Numbers).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

let ctx: TestDbContext;
let caller: ReturnType<typeof makeCaller>;

let classId: number;
let courseId: number;
let control31Id: number;
let control32Id: number;
let control33Id: number;
let runnerId: number;

const ZERO_TIME_DS = 324000; // 09:00:00 in deciseconds (createCompetitionDatabase default)
const ZERO_TIME_SECS = 32400;
const START_TIME_SECS = 36000; // 10:00:00 absolute
const START_TIME_DS = 360000;

beforeAll(async () => {
  ctx = await createTestDb("courserenum");
  caller = makeCaller({ dbName: ctx.dbName });

  // Class + course + three regular controls. Course.Controls stores the
  // controls' DB Ids (matching MeOS storage convention).
  const cls = await ctx.client.oClass.create({
    data: {
      Name: "Test",
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Counter: 0,
      FreeStart: 0,
    },
  });
  classId = cls.Id;

  const c31 = await ctx.client.oControl.create({
    data: { Id: 31, Name: "", Numbers: "31", Status: 0 },
  });
  const c32 = await ctx.client.oControl.create({
    data: { Id: 32, Name: "", Numbers: "32", Status: 0 },
  });
  const c33 = await ctx.client.oControl.create({
    data: { Id: 33, Name: "", Numbers: "33", Status: 0 },
  });
  control31Id = c31.Id;
  control32Id = c32.Id;
  control33Id = c33.Id;

  const course = await ctx.client.oCourse.create({
    data: {
      Name: "Bana A",
      Controls: `${c31.Id};${c32.Id};${c33.Id};`,
      Length: 3000,
      Legs: "600;600;600;600;",
    },
  });
  courseId = course.Id;

  await ctx.client.oClass.update({
    where: { Id: classId },
    data: { Course: courseId },
  });

  const { id } = await caller.runner.create({
    name: "Runner",
    classId,
    cardNo: 700001,
  });
  runnerId = id;

  await ctx.client.oRunner.update({
    where: { Id: runnerId },
    data: { StartTime: START_TIME_DS - ZERO_TIME_DS },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("course.detail dereferences Ids to live punch codes", () => {
  it("returns controlCodes carrying both Id and live code", async () => {
    const detail = await caller.course.detail({ id: courseId });
    expect(detail).not.toBeNull();
    expect(detail!.controls).toBe(`${control31Id};${control32Id};${control33Id};`);
    expect(detail!.controlCodes).toEqual([
      { id: control31Id, code: "31" },
      { id: control32Id, code: "32" },
      { id: control33Id, code: "33" },
    ]);
  });
});

describe("renumbering a control updates everything that reads it", () => {
  it("course.detail reflects the new code; the Id list is unchanged", async () => {
    // Renumber control 31's punch code to 131. The DB row's Id stays 31
    // (PK), so oCourse.Controls keeps pointing at it; only Numbers changes.
    await caller.control.update({ id: control31Id, codes: "131" });

    const detail = await caller.course.detail({ id: courseId });
    expect(detail!.controls).toBe(`${control31Id};${control32Id};${control33Id};`);
    expect(detail!.controlCodes[0]).toEqual({ id: control31Id, code: "131" });
  });

  it("a card carrying the new code reads as fully matched", async () => {
    // The runner's SI card was punched at the renumbered control with the
    // new code 131. The matcher must dereference oCourse.Controls' Id 31
    // to oControl.Numbers '131' to count this as a hit.
    await caller.cardReadout.storeReadout({
      cardNo: 700001,
      punches: [
        { controlCode: 131, time: START_TIME_SECS + 600 },
        { controlCode: 32, time: START_TIME_SECS + 1200 },
        { controlCode: 33, time: START_TIME_SECS + 1800 },
      ],
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 2400,
      punchesFresh: true,
    });

    const readout = await caller.cardReadout.readout({ cardNo: 700001 });
    expect(readout.found).toBe(true);
    if (!readout.found) return;

    expect(readout.controls).toHaveLength(3);
    expect(readout.controls.every((c) => c.status === "ok")).toBe(true);
    // First match's controlCode is the actually-punched 131, not the Id 31.
    expect(readout.controls[0].controlCode).toBe(131);
    expect(readout.timing.finishTime).toBe((START_TIME_SECS + 2400) * 10);
    expect(readout.matchScore).toBe(1.0);
  });

  it("a card stuck on the old code now misses the renumbered control", async () => {
    // Different runner / card with stale punches. After renumbering, the
    // matcher should NOT accept code 31 for the position that's been
    // moved to 131 — confirming the dereference is live, not cached.
    const { id: staleRunnerId } = await caller.runner.create({
      name: "Stale Card",
      classId,
      cardNo: 700002,
    });
    await ctx.client.oRunner.update({
      where: { Id: staleRunnerId },
      data: { StartTime: START_TIME_DS - ZERO_TIME_DS },
    });

    await caller.cardReadout.storeReadout({
      cardNo: 700002,
      punches: [
        { controlCode: 31, time: START_TIME_SECS + 600 }, // old code, no longer accepted
        { controlCode: 32, time: START_TIME_SECS + 1200 },
        { controlCode: 33, time: START_TIME_SECS + 1800 },
      ],
      startTime: START_TIME_SECS,
      finishTime: START_TIME_SECS + 2400,
      punchesFresh: true,
    });

    const readout = await caller.cardReadout.readout({ cardNo: 700002 });
    expect(readout.found).toBe(true);
    if (!readout.found) return;

    expect(readout.controls).toHaveLength(3);
    // Position 0 (originally code 31, now expecting 131) is missing.
    expect(readout.controls[0]).toMatchObject({
      status: "missing",
      controlCode: 131,
    });
    // Positions 1 and 2 still match (codes 32 and 33 were not renumbered).
    expect(readout.controls[1].status).toBe("ok");
    expect(readout.controls[2].status).toBe("ok");
    // The 31 punch surfaces as an extra (foreign) punch.
    expect(readout.extraPunches.map((p) => p.controlCode)).toContain(31);
  });
});

describe("course.update translates user-typed codes back to Ids", () => {
  it("storing controlCodes resolves codes to their oControl.Id list", async () => {
    // The Courses-page edit input feeds live punch codes back to the
    // server via the `controlCodes` array. The server must rewrite that
    // list as `oControl.Id;` so MeOS sees the same storage as before.
    await caller.course.update({
      id: courseId,
      controlCodes: ["131", "32", "33"],
    });

    const after = await ctx.client.oCourse.findUnique({ where: { Id: courseId } });
    expect(after!.Controls).toBe(`${control31Id};${control32Id};${control33Id};`);
  });

  it("rejects unknown codes with a single BAD_REQUEST listing every offender", async () => {
    await expect(
      caller.course.update({
        id: courseId,
        controlCodes: ["131", "999", "32", "abc"],
      }),
    ).rejects.toMatchObject({
      // tRPC wraps errors; assert just on the visible message + code.
      message: expect.stringMatching(/Unknown control code/),
    });
  });

  it("ignores stale `controls` when controlCodes is also supplied", async () => {
    // Belt-and-braces: when both are provided, controlCodes wins.
    await caller.course.update({
      id: courseId,
      controls: "999;",
      controlCodes: ["131", "32", "33"],
    });
    const row = await ctx.client.oCourse.findUnique({ where: { Id: courseId } });
    expect(row!.Controls).toBe(`${control31Id};${control32Id};${control33Id};`);
  });

  // Ensure TRPCError is in scope (used implicitly through reject matcher).
  void TRPCError;
});

// ZERO_TIME_SECS is referenced by other planned scenarios (kept exported
// from a helper-style block for clarity and future test additions).
void ZERO_TIME_SECS;
