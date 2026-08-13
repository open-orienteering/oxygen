/**
 * Regression test: the map overlay endpoints must share one control ID
 * space — the public control id (first punch code, `seq` fallback).
 *
 * Symptom that motivated this test: with no selection the map drew all
 * control circles, but selecting a class / course / control on any page
 * made every circle and code label vanish — only leg lines remained.
 *
 * Root cause: `course.controlCoordinates` returned `id = seq`, while
 * `course.list`'s per-course `controls` string and the Controls page's
 * row ids (`publicControlId`) are **punch codes**. MapPanel's
 * "show only relevant" filter compares the two, so as soon as a
 * selection existed every regular control got `visible: false`
 * whenever seq ≠ code — which is the normal state for any event whose
 * controls were created through `allocate_event_seq()` (seq 1, 2, 3…
 * vs codes 31+). Leg lines draw from course GeoJSON and never consult
 * that filter, hence "lines yes, circles no".
 *
 * These assertions pin the cross-endpoint contract the map relies on.
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

const CODES = [31, 32, 45];

beforeAll(async () => {
  ctx = await createTestEvent("map_id_space");
  caller = makeCaller(ctx.event);

  // Controls created WITHOUT explicit seq — allocate_event_seq() hands
  // out 1, 2, 3…, guaranteeing seq ≠ code like any real fresh event.
  const controlIds: string[] = [];
  for (const [i, code] of CODES.entries()) {
    const row = await ctx.db.control.create({
      data: {
        eventId: ctx.eventId,
        codes: String(code),
        xpos: 100 + i * 10,
        ypos: -50 - i * 10,
      },
      select: { id: true, seq: true },
    });
    // Sanity: the premise of the whole test.
    expect(row.seq).not.toBe(code);
    controlIds.push(row.id);
  }

  const course = await ctx.db.course.create({
    data: { eventId: ctx.eventId, name: "Bana 1", lengthM: 2500 },
    select: { id: true },
  });
  for (const [pos, controlId] of controlIds.entries()) {
    await ctx.db.courseControl.create({
      data: { courseId: course.id, position: pos, controlId },
    });
  }

  // Class + runner so controlCompletionStatus returns rows.
  const cls = await ctx.db.class.create({
    data: { eventId: ctx.eventId, name: "H21", courseId: course.id },
    select: { id: true },
  });
  await ctx.db.runner.create({
    data: { eventId: ctx.eventId, name: "Test Runner", classId: cls.id },
  });
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  await disconnect();
}, 30_000);

describe("map overlay control ID space", () => {
  it("controlCoordinates ids are public control ids (first punch code)", async () => {
    const coords = await caller.course.controlCoordinates();
    expect(coords.length).toBe(CODES.length);
    expect(coords.map((c) => c.id).sort((a, b) => a - b)).toEqual(CODES);
  });

  it("course.list controls tokens resolve against controlCoordinates ids", async () => {
    const [coords, courses] = await Promise.all([
      caller.course.controlCoordinates(),
      caller.course.list(),
    ]);
    const idSet = new Set(coords.map((c) => String(c.id)));
    const course = courses.find((c) => c.name === "Bana 1");
    expect(course).toBeDefined();
    const tokens = course!.controls.split(";").filter(Boolean);
    expect(tokens.length).toBe(CODES.length);
    for (const token of tokens) {
      expect(idSet.has(token)).toBe(true);
    }
  });

  it("controlCompletionStatus controlId joins against controlCoordinates ids", async () => {
    const [coords, completion] = await Promise.all([
      caller.course.controlCoordinates(),
      caller.course.controlCompletionStatus(),
    ]);
    const idSet = new Set(coords.map((c) => c.id));
    expect(completion.length).toBe(CODES.length);
    for (const row of completion) {
      expect(idSet.has(row.controlId)).toBe(true);
    }
  });
});
