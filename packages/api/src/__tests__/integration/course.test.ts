/**
 * Integration tests for the course tRPC router.
 *
 * Covers CRUD + bulk update + the control-list renumbering that happens
 * when a course's controlIds are rewritten (legs / positions must be
 * regenerated from scratch).
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
let controlSeqs: number[] = [];

beforeAll(async () => {
  ctx = await createTestEvent("course");
  caller = makeCaller(ctx.event);
  for (const code of ["31", "32", "33", "34"]) {
    const c = await caller.control.create({ codes: code });
    controlSeqs.push(c.id);
  }
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("course.create", () => {
  it("creates a course with no controls", async () => {
    const c = await caller.course.create({
      name: "Bare",
      length: 1234,
    });
    expect(c.id).toBe(1);
    const list = await caller.course.list();
    const item = list.find((cc) => cc.id === c.id);
    expect(item?.length).toBe(1234);
    expect(item?.controlCount).toBe(0);
  });

  it("creates a course with an ordered control list", async () => {
    const c = await caller.course.create({
      name: "With Controls",
      length: 5000,
      controlIds: controlSeqs,
    });
    const list = await caller.course.list();
    const item = list.find((cc) => cc.id === c.id);
    expect(item?.controlCount).toBe(controlSeqs.length);
    // Regression: `course.list` must include the ordered `;`-joined
    // control-codes string. The web `MapPanel` fallback leg renderer
    // (used for non-highlighted courses) relies on this to draw leg
    // lines. When it was hard-coded to "" the map showed control
    // circles but no leg lines for any course except the highlighted
    // one.
    expect(item?.controls).toBe(controlSeqs.join(";"));

    const detail = await caller.course.getById({ id: c.id });
    // CourseDetail.controls is a ";"-joined string of code values
    // (or seq if the control has no codes); the rich list is in
    // controlCodes.
    expect(detail.controls).toBe(controlSeqs.join(";"));
    expect(detail.controlCount).toBe(controlSeqs.length);
    expect(detail.controlCodes.map((c) => c.id)).toEqual(controlSeqs);
  });

  it("atomically links a newly created course to a class", async () => {
    const cls = await caller.class.create({ name: "Auto-link class" });
    const course = await caller.course.create({
      name: "Auto-link class",
      linkClassId: cls.id,
    });
    expect((await caller.class.getById({ id: cls.id })).courseId).toBe(course.id);
    expect(
      await ctx.db.journalEntry.count({
        where: { eventId: ctx.eventId, type: "class.upserted" },
      }),
    ).toBeGreaterThan(0);
  });

  it("rolls back the course when the target class is already linked", async () => {
    const cls = await caller.class.create({ name: "Already linked" });
    await caller.course.create({
      name: "First linked course",
      linkClassId: cls.id,
    });
    const before = await ctx.db.course.count({
      where: { eventId: ctx.eventId },
    });
    await expect(
      caller.course.create({
        name: "Must roll back",
        linkClassId: cls.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await ctx.db.course.count({ where: { eventId: ctx.eventId } }),
    ).toBe(before);
    expect(
      await ctx.db.course.findFirst({
        where: { eventId: ctx.eventId, name: "Must roll back" },
      }),
    ).toBeNull();
  });
});

describe("course.update — controlIds replacement", () => {
  it("rewrites the control list when controlIds is provided", async () => {
    const c = await caller.course.create({
      name: "Renumber Me",
      controlIds: [controlSeqs[0], controlSeqs[1], controlSeqs[2]],
    });

    // Now replace with a different order (reverse subset).
    await caller.course.update({
      id: c.id,
      controlIds: [controlSeqs[2], controlSeqs[0]],
    });

    const detail = await caller.course.getById({ id: c.id });
    expect(detail.controlCodes.map((c) => c.id)).toEqual([
      controlSeqs[2],
      controlSeqs[0],
    ]);
  });

  it("leaves the control list alone when controlIds is omitted", async () => {
    const c = await caller.course.create({
      name: "Preserve Me",
      controlIds: [controlSeqs[0], controlSeqs[1]],
    });
    await caller.course.update({ id: c.id, name: "Renamed", length: 9999 });
    const detail = await caller.course.getById({ id: c.id });
    expect(detail.name).toBe("Renamed");
    expect(detail.length).toBe(9999);
    expect(detail.controlCodes.map((c) => c.id)).toEqual([
      controlSeqs[0],
      controlSeqs[1],
    ]);
  });

  it("clears the control list when controlIds is an empty array", async () => {
    const c = await caller.course.create({
      name: "Empty Me",
      controlIds: [controlSeqs[0], controlSeqs[1]],
    });
    await caller.course.update({ id: c.id, controlIds: [] });
    const detail = await caller.course.getById({ id: c.id });
    expect(detail.controlCount).toBe(0);
    expect(detail.controlCodes).toEqual([]);
  });
});

describe("course.bulkUpdate", () => {
  it("applies firstAsStart / lastAsFinish flags across many courses", async () => {
    const a = await caller.course.create({ name: "Bulk A" });
    const b = await caller.course.create({ name: "Bulk B" });
    const res = await caller.course.bulkUpdate({
      ids: [a.id, b.id],
      firstAsStart: true,
      lastAsFinish: true,
      numberOfMaps: 50,
    });
    expect(res.count).toBe(2);
    const list = await caller.course.list();
    for (const id of [a.id, b.id]) {
      const item = list.find((c) => c.id === id);
      expect(item?.firstAsStart).toBe(true);
      expect(item?.lastAsFinish).toBe(true);
      expect(item?.numberOfMaps).toBe(50);
    }
  });
});

describe("course.delete (soft)", () => {
  it("hides deleted courses but keeps the row", async () => {
    const c = await caller.course.create({ name: "Doomed Course" });
    await caller.course.delete({ id: c.id });
    const list = await caller.course.list();
    expect(list.find((cc) => cc.name === "Doomed Course")).toBeUndefined();

    const row = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, name: "Doomed Course" },
      select: { removed: true },
    });
    expect(row?.removed).toBe(true);
  });
});
