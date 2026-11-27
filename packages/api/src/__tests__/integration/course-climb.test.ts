/**
 * The course's stored climb (docs/course-elevation.md §6): a climb computed
 * from the pinned document's stored height field after an edit commits,
 * cleared and written again when the geometry changes; a typed or imported
 * climb wins and can be cleared back; free order, a map without a stored
 * field, variants, clone, the catch-up mutation, the journal payload and
 * the column's constraint.
 *
 * Fixture: the shared terrain tests' hill (four contour rings around
 * (30, 30) mm at 1:15 000) as a synthetic document pinned to the event,
 * its `contours` field derived and stored.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "crypto";
import { mapDocument } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { FLAT, HILL, encodeTerrainDoc } from "../helpers/terrain-doc.js";
import { deriveDocumentHeightfield, readHeightfield } from "../../map-store/heightfield.js";
import { computeMissingClimbs, refreshComputedClimbs, refreshMarkedClimbs, resetClimbFields } from "../../course-climb.js";
import { acquireLease, releaseLease } from "../../sync/lease.js";
import { withClimbMarks } from "../../course-climb-pending.js";
import { rebuildCourseLengths } from "../../course-geometry.js";

// The reads of the event's chosen routes, and a hook that runs after a course's climb has been journaled.
const spy = vi.hoisted(() => ({ routeReads: 0, afterEmit: null as null | (() => Promise<void>) }));
vi.mock("../../leg-routes.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../leg-routes.js")>();
  return { ...real, chosenLegRoutes: (...args: Parameters<typeof real.chosenLegRoutes>) => { spy.routeReads++; return real.chosenLegRoutes(...args); } };
});
vi.mock("../../referenceJournal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../referenceJournal.js")>();
  return {
    ...real,
    emitCourseUpserted: async (...args: Parameters<typeof real.emitCourseUpserted>) => {
      const out = await real.emitCourseUpserted(...args);
      const hook = spy.afterEmit;
      spy.afterEmit = null;
      await hook?.();
      return out;
    },
  };
});

const suffix = randomBytes(4).toString("hex");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let ctx: TestEventContext;
let flat: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let flatCaller: ReturnType<typeof makeCaller>;
let top: number;

async function pinDocument(t: TestEventContext, objects: typeof HILL, salt: string): Promise<string> {
  const sourceBytes = Buffer.from(`course-climb-source-${salt}`);
  const sourceHash = sha(sourceBytes);
  await t.db.mapSource.create({ data: { fileHash: sourceHash, kind: "ocad", bytes: sourceBytes, sizeBytes: sourceBytes.byteLength, fileName: "synthetic.ocd" } });
  const bytes = encodeTerrainDoc(objects, salt, sourceHash);
  const hash = sha(bytes);
  const { header } = mapDocument.readMapDocumentHeader(bytes);
  await t.db.mapDocument.create({
    data: {
      hash, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "test", libraryVersion: "none", sourceHash,
      header: JSON.parse(JSON.stringify({ ...header, symbols: undefined, strings: undefined })), report: {},
    },
  });
  await t.db.mapFile.create({ data: { eventId: t.eventId, fileName: "synthetic.ocd", sourceHash, documentHash: hash, scale: 15000 } });
  return hash;
}

const rowOf = (t: TestEventContext, seq: number) => t.db.course.findFirstOrThrow({ where: { eventId: t.eventId, seq } });
const climbOf = async (seq: number) => { const r = await rowOf(ctx, seq); return { m: r.climbM, source: r.climbSource }; };

beforeAll(async () => {
  resetClimbFields();
  ctx = await createTestEvent("course_climb");
  flat = await createTestEvent("course_climb_flat");
  caller = makeCaller(ctx.event);
  flatCaller = makeCaller(flat.event);
  const hill = await pinDocument(ctx, HILL, `hill-${suffix}`);
  await deriveDocumentHeightfield(ctx.db, hill);
  expect((await readHeightfield(ctx.db, hill))?.bytes, "the hill's field is stored").toBeTruthy();
  // A pinned document whose field was never derived: nothing stored to read.
  await pinDocument(flat, FLAT, `flat-${suffix}`);
  for (const c of [caller, flatCaller]) {
    await c.control.create({ status: 4, xpos: 12, ypos: 30 });
    await c.control.create({ status: 5, xpos: 48, ypos: 30 });
  }
  // On the hill's top, and two on its east slope.
  top = (await caller.control.create({ codes: "31", xpos: 30, ypos: 30 })).id;
  await caller.control.create({ codes: "32", xpos: 38, ypos: 30 });
  await caller.control.create({ codes: "33", xpos: 44, ypos: 30 });
  await flatCaller.control.create({ codes: "31", xpos: 5, ypos: 5 });
});

afterAll(async () => {
  await ctx.cleanup();
  await flat.cleanup();
  await disconnect();
});

describe("the course's stored climb (docs/course-elevation.md §6)", () => {
  let over: number;

  it("a created course gets its computed climb once the create has committed", async () => {
    over = (await caller.course.create({ name: "Over the top", controlIds: [top] })).id;
    const c = await climbOf(over);
    expect(c.source).toBe("computed");
    // Start outside the lowest ring, the control on the top: at least three 5 m intervals up.
    expect(c.m).toBeGreaterThanOrEqual(12);
    expect(c.m).toBeLessThanOrEqual(30);
    const listed = (await caller.course.list()).find((x) => x.id === over)!;
    expect(listed).toMatchObject({ climb: c.m, climbSource: "computed" });
    expect((await caller.course.detail({ id: over })).climbSource).toBe("computed");
  });

  it("a geometry change clears it and it is computed again", async () => {
    const before = await climbOf(over);
    // The control moved off the top to the hill's foot: the legs only cut its side, the course climbs less.
    await caller.control.update({ id: top, xpos: 30, ypos: 48 });
    const moved = await climbOf(over);
    expect(moved.source === "computed" ? moved.m : 0).toBeLessThan(before.m);
    await caller.control.update({ id: top, xpos: 30, ypos: 30 });
    expect(await climbOf(over)).toEqual(before);
  });

  it("the computed climb is journaled without its source and does not advance the course's token", async () => {
    const row = await rowOf(ctx, over);
    const entries = await ctx.db.journalEntry.findMany({ where: { eventId: ctx.eventId, type: "course.upserted" }, orderBy: { hlc: "desc" }, take: 1 });
    const fields = (entries[0].payload as { fields: Record<string, unknown> }).fields;
    expect(fields.climbM).toBe(row.climbM);
    expect("climbSource" in fields).toBe(false);
    expect(BigInt(String(fields.version))).toBe(row.version);
  });

  it("a typed climb wins and survives edits; clearing it hands the climb back to the computed one", async () => {
    const computed = await climbOf(over);
    await caller.course.update({ id: over, climb: 99 });
    expect(await climbOf(over)).toEqual({ m: 99, source: "manual" });
    await caller.control.update({ id: top, xpos: 29, ypos: 30 });
    await caller.control.update({ id: top, xpos: 30, ypos: 30 });
    expect(await climbOf(over)).toEqual({ m: 99, source: "manual" });
    expect((await caller.course.list()).find((x) => x.id === over)!.climbSource).toBe("manual");
    await caller.course.update({ id: over, climb: null });
    expect(await climbOf(over)).toEqual(computed);
    await caller.course.update({ id: over, climb: 77 });
    await caller.course.update({ id: over, climb: 0 });
    expect(await climbOf(over)).toEqual(computed);
  });

  it("a climb stored without a source is a typed one (an older image's write): never replaced", async () => {
    await ctx.db.course.update({ where: { id: (await rowOf(ctx, over)).id }, data: { climbM: 55, climbSource: null } });
    await caller.control.update({ id: top, xpos: 29, ypos: 30 });
    await caller.control.update({ id: top, xpos: 30, ypos: 30 });
    expect(await climbOf(over)).toEqual({ m: 55, source: null });
    expect((await caller.course.list()).find((x) => x.id === over)!.climbSource).toBe("manual");
    await caller.course.update({ id: over, climb: null });
    expect((await climbOf(over)).source).toBe("computed");
  });

  it("a clone computes its own climb; a typed climb is copied with its source", async () => {
    const computed = await climbOf(over);
    const copy = await caller.course.clone({ id: over, name: "Copy" });
    expect(await climbOf(copy.id)).toEqual(computed);
    await caller.course.update({ id: over, climb: 99 });
    const typed = await caller.course.clone({ id: over, name: "Typed copy" });
    expect(await climbOf(typed.id)).toEqual({ m: 99, source: "manual" });
    await caller.course.update({ id: over, climb: null });
  });

  it("free order is never computed; back in order it is", async () => {
    const id = (await caller.course.create({ name: "Free", controlIds: [top], orderMode: "free_order" })).id;
    expect(await climbOf(id)).toEqual({ m: 0, source: null });
    await caller.course.update({ id, orderMode: "ordered" });
    expect((await climbOf(id)).source).toBe("computed");
    await caller.course.update({ id, orderMode: "free_order" });
    expect(await climbOf(id)).toEqual({ m: 0, source: null });
  });

  it("refreshClimbs fills courses that have none and leaves the others", async () => {
    const computed = await climbOf(over);
    const row = await rowOf(ctx, over);
    await ctx.db.course.update({ where: { id: row.id }, data: { climbM: 0, climbSource: null } });
    const { written } = await caller.course.refreshClimbs();
    expect(written).toBeGreaterThanOrEqual(1);
    expect(await climbOf(over)).toEqual(computed);
    expect((await caller.course.refreshClimbs()).written).toBe(0);
  });

  it("a map whose field is not stored gives no climb, and nothing is derived to get one", async () => {
    const id = (await flatCaller.course.create({ name: "Flat", controlIds: [(await flatCaller.control.list()).find((c) => c.codes === "31")!.id] })).id;
    const r = await rowOf(flat, id);
    expect({ m: r.climbM, source: r.climbSource }).toEqual({ m: 0, source: null });
    expect((await flatCaller.course.refreshClimbs()).written).toBe(0);
    expect(await flat.db.mapHeightfield.count({ where: { documentHash: (await flat.db.mapFile.findFirstOrThrow({ where: { eventId: flat.eventId } })).documentHash! } })).toBe(0);
  });

  it("another request cannot take an edit's marks before the edit commits", async () => {
    const row = await rowOf(ctx, over);
    const computed = await climbOf(over);
    const { marks } = await withClimbMarks(() =>
      ctx.db.$transaction(async (tx) => {
        await rebuildCourseLengths(tx, ctx.eventId, [row.id]);
        // A heartbeat of an open editor lands while the edit is still open: it has nothing to compute.
        await caller.course.presence({ courseId: over, mode: "course", clientId: "other-tab" });
        await caller.course.refreshClimbs();
      }),
    );
    expect(await climbOf(over), "cleared by the edit, not yet computed").toEqual({ m: 0, source: null });
    expect(marks.get(ctx.eventId)).toEqual(new Set([row.id]));
    expect(await refreshMarkedClimbs(ctx.db, marks)).toBe(1);
    expect(await climbOf(over)).toEqual(computed);
  });

  it("each geometry edit journals the course cleared, then computed", async () => {
    const row = await rowOf(ctx, over);
    const since = await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId, type: "course.upserted", payload: { path: ["id"], equals: row.id } } });
    await caller.control.update({ id: top, xpos: 30, ypos: 31 });
    await caller.control.update({ id: top, xpos: 30, ypos: 30 });
    const entries = await ctx.db.journalEntry.findMany({ where: { eventId: ctx.eventId, type: "course.upserted", payload: { path: ["id"], equals: row.id } }, orderBy: { hlc: "asc" }, skip: since });
    const climbs = entries.map((e) => (e.payload as { fields: { climbM: number } }).fields.climbM);
    expect(climbs.length).toBeGreaterThanOrEqual(4);
    expect(climbs.at(-2)).toBe(0);
    expect(climbs.at(-1)).toBe((await climbOf(over)).m);
  });

  it("moving the course's ends in bulk clears a computed climb and computes it again", async () => {
    const before = await climbOf(over);
    expect(before.source).toBe("computed");
    await caller.course.bulkUpdate({ ids: [over], firstAsStart: true });
    const ends = await climbOf(over);
    expect(ends.m === 0 ? ends.source : "computed").toBe(ends.m === 0 ? null : "computed");
    await caller.course.bulkUpdate({ ids: [over], firstAsStart: false });
    expect(await climbOf(over)).toEqual(before);
    await caller.course.bulkUpdate({ ids: [over], climb: 64 });
    expect(await climbOf(over)).toEqual({ m: 64, source: "manual" });
    await caller.course.bulkUpdate({ ids: [over], climb: null });
    expect(await climbOf(over)).toEqual(before);
  });

  it("course.update moving the course's ends clears a computed climb and computes it again", async () => {
    const before = await climbOf(over);
    expect(before.source).toBe("computed");
    // A stale number the compute would not write: the update must not leave it standing.
    await ctx.db.course.updateMany({ where: { eventId: ctx.eventId, seq: over }, data: { climbM: 777, climbSource: "computed" } });
    await caller.course.update({ id: over, firstAsStart: true });
    expect((await climbOf(over)).m).not.toBe(777);
    await ctx.db.course.updateMany({ where: { eventId: ctx.eventId, seq: over }, data: { climbM: 777, climbSource: "computed" } });
    await caller.course.update({ id: over, firstAsStart: false });
    expect(await climbOf(over)).toEqual(before);
    await ctx.db.course.updateMany({ where: { eventId: ctx.eventId, seq: over }, data: { climbM: 777, climbSource: "computed" } });
    await caller.course.update({ id: over, lastAsFinish: false });
    expect((await climbOf(over)).m).not.toBe(777);
  });

  it("a clear outside an edit that journals the course journals the cleared row itself (§6)", async () => {
    // The flat event's field is not stored: after a route is chosen the course gets no climb, but the clear is journaled.
    const a = (await flatCaller.control.create({ codes: "41", xpos: 8, ypos: 20 })).id;
    const b = (await flatCaller.control.create({ codes: "42", xpos: 30, ypos: 20 })).id;
    const id = (await flatCaller.course.create({ name: "Cleared", controlIds: [a, b] })).id;
    const row = await rowOf(flat, id);
    await flat.db.course.update({ where: { id: row.id }, data: { climbM: 55, climbSource: "computed" } });
    const latest = async () => {
      const e = await flat.db.journalEntry.findFirstOrThrow({ where: { eventId: flat.eventId, type: "course.upserted", payload: { path: ["id"], equals: row.id } }, orderBy: { hlc: "desc" } });
      return (e.payload as { fields: { climbM: number } }).fields.climbM;
    };
    await flatCaller.legRoute.save({ fromControlId: a, toControlId: b, points: [{ x: 18, y: 30 }] });
    expect((await rowOf(flat, id)).climbM).toBe(0);
    expect(await latest()).toBe(0);
  });

  it("a climb arriving through the journal is held as a typed one, and a cleared one is computed again", async () => {
    const row = await rowOf(ctx, over);
    const computed = await climbOf(over);
    expect(computed.source).toBe("computed");
    const latest = await ctx.db.journalEntry.findFirstOrThrow({ where: { eventId: ctx.eventId, type: "course.upserted", payload: { path: ["id"], equals: row.id } }, orderBy: { hlc: "desc" } });
    const payload = latest.payload as { fields: Record<string, unknown> };
    const push = async (climbM: number) => {
      const res = await caller.events.push({
        events: [{ id: randomUUID(), type: "course.upserted" as never, competitionId: ctx.event.nameId, stationId: "peer", timestamp: Date.now(), payload: { ...payload, fields: { ...payload.fields, climbM } } as Record<string, unknown> }],
      });
      expect(res.failed).toEqual([]);
    };
    // A peer's typed climb over this node's computed one: the next rebuild must not clear it.
    await push(80);
    expect(await climbOf(over)).toEqual({ m: 80, source: null });
    await caller.control.update({ id: top, xpos: 29, ypos: 30 });
    await caller.control.update({ id: top, xpos: 30, ypos: 30 });
    expect(await climbOf(over)).toEqual({ m: 80, source: null });
    // A peer's cleared climb over this node's typed one: no climb, so the compute fills it.
    await caller.course.update({ id: over, climb: 70 });
    await push(0);
    expect(await climbOf(over)).toEqual({ m: 0, source: null });
    await caller.course.refreshClimbs();
    expect(await climbOf(over)).toEqual(computed);
  });

  it("a typed source over an empty climb is no climb: the compute fills it", async () => {
    const row = await rowOf(ctx, over);
    const computed = await climbOf(over);
    await ctx.db.course.update({ where: { id: row.id }, data: { climbM: 0, climbSource: "manual" } });
    await caller.course.refreshClimbs();
    expect(await climbOf(over)).toEqual(computed);
  });

  it("the column takes its three sources and nothing else", async () => {
    const row = await rowOf(ctx, over);
    await expect(ctx.db.$executeRaw`UPDATE "oxygen"."courses" SET "climb_source" = 'guess' WHERE "id" = ${row.id}::uuid`).rejects.toThrow();
    for (const s of ["manual", "file", "computed"]) {
      await ctx.db.$executeRaw`UPDATE "oxygen"."courses" SET "climb_source" = ${s} WHERE "id" = ${row.id}::uuid`;
    }
  });
});

describe("the compute under a lease and over many courses (docs/course-elevation.md §6)", () => {
  const journal = () => ctx.db.journalEntry.count({ where: { eventId: ctx.eventId, type: "course.upserted" } });
  const uuidOf = async (code: string) => (await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: code } })).id;

  it("a node that does not hold the event's lease computes nothing and journals nothing; a courseObject write there succeeds and touches no course", async () => {
    await ctx.db.course.updateMany({ where: { eventId: ctx.eventId, removed: false }, data: { climbM: 0, climbSource: null } });
    const before = JSON.stringify((await ctx.db.course.findMany({ where: { eventId: ctx.eventId }, orderBy: { id: "asc" } })).map((c) => [c.id, c.climbM, c.climbSource]));
    const entries = await journal();
    await acquireLease(ctx.db, ctx.eventId, "venue-d8");
    try {
      expect(await computeMissingClimbs(ctx.db, ctx.eventId)).toBe(0);
      expect(await refreshComputedClimbs(ctx.db, ctx.eventId)).toBe(0);
      const { marks } = await withClimbMarks(async () => { await rebuildCourseLengths(ctx.db, ctx.eventId, [], {}); });
      expect(await refreshMarkedClimbs(ctx.db, marks)).toBe(0);
      // The cloud-owned write goes ahead and enqueues a route refresh that does nothing.
      await caller.courseObject.create({ kind: "oob_area", geometry: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }], props: {}, scope: { all: true } });
      expect(JSON.stringify((await ctx.db.course.findMany({ where: { eventId: ctx.eventId }, orderBy: { id: "asc" } })).map((c) => [c.id, c.climbM, c.climbSource]))).toBe(before);
      expect(await journal()).toBe(entries);
    } finally {
      await releaseLease(ctx.db, ctx.eventId);
    }
    expect(await refreshComputedClimbs(ctx.db, ctx.eventId)).toBeGreaterThan(0);
  });

  it("the event's chosen routes are read once for an all-courses compute, and again only when a route was chosen in between", async () => {
    const p = (await caller.control.create({ codes: "61", xpos: 10, ypos: 30 })).id;
    const q = (await caller.control.create({ codes: "62", xpos: 50, ypos: 30 })).id;
    const first = (await caller.course.create({ name: "Over the line 1", controlIds: [p, q] })).id;
    const second = (await caller.course.create({ name: "Over the line 2", controlIds: [p, q] })).id;
    const clear = () => ctx.db.course.updateMany({ where: { eventId: ctx.eventId, removed: false }, data: { climbM: 0, climbSource: null } });
    const courses = await ctx.db.course.count({ where: { eventId: ctx.eventId, removed: false, orderMode: "ordered" } });
    expect(courses).toBeGreaterThanOrEqual(3);

    await clear();
    spy.routeReads = 0;
    expect(await computeMissingClimbs(ctx.db, ctx.eventId)).toBeGreaterThanOrEqual(3);
    expect(spy.routeReads).toBe(1);
    const along = (await climbOf(first)).m;
    expect(along).toBeGreaterThan(0);
    expect((await climbOf(second)).m).toBe(along);

    // A route chosen after the first course was written, before the second: the second reads along it.
    await clear();
    const route = { eventId: ctx.eventId, fromControlId: await uuidOf("61"), toControlId: await uuidOf("62"), points: [{ x: 30, y: 58 }], source: "drawn", chosen: true };
    spy.afterEmit = async () => { await ctx.db.legRoute.create({ data: route }); };
    spy.routeReads = 0;
    const ids = (await ctx.db.course.findMany({ where: { eventId: ctx.eventId, seq: { in: [first, second] } }, orderBy: { id: "asc" } })).map((c) => c.id);
    await computeMissingClimbs(ctx.db, ctx.eventId, ids);
    expect(spy.routeReads).toBe(2);
    const [a, b] = (await ctx.db.course.findMany({ where: { eventId: ctx.eventId, seq: { in: [first, second] } }, orderBy: { id: "asc" } })).map((c) => c.climbM);
    expect(a).toBe(along);
    expect(b).toBeLessThan(along);
    await ctx.db.legRoute.deleteMany({ where: { eventId: ctx.eventId, fromControlId: route.fromControlId } });
    await caller.course.delete({ id: first });
    await caller.course.delete({ id: second });
  });
});
