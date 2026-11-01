/**
 * Course objects (slice D, row D2; docs/course-layer.md §8):
 *
 *   - courseObject.create / update / delete / reorder / list, every phase-1
 *     kind, the wire form with public ids in the scope
 *   - scope validation (unknown course / class), inset_frame refused
 *   - the per-object token: a stale baseVersion is a CONFLICT carrying the
 *     object now (differing null), no token = last-write-wins, reorder
 *     leaves tokens alone
 *   - kiosk-key read; writes need courses.edit
 *   - the scope rule over the event's classes (course_id and the pool)
 *   - the checkout snapshot carries the rows verbatim
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import { versionConflictOf, type VersionConflictData, type course } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { VersionConflictError } from "../../version-conflict.js";
import { classesByCourse, loadCourseObjects, objectsInScope } from "../../course-objects.js";
import { exportEventSnapshot, importEventSnapshot } from "../../sync/lease.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let courseA: number;
let courseB: number;
let classA: number;
let classPool: number;
const suffix = randomBytes(4).toString("hex");

const SQUARE = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];

async function conflictOf(p: Promise<unknown>): Promise<VersionConflictData> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TRPCError);
    const err = e as TRPCError;
    expect(err.code).toBe("CONFLICT");
    expect(err.cause).toBeInstanceOf(VersionConflictError);
    const data = versionConflictOf((err.cause as VersionConflictError).data);
    expect(data).not.toBeNull();
    return data!;
  }
  throw new Error("expected a CONFLICT");
}

beforeAll(async () => {
  ctx = await createTestEvent("course_objects");
  caller = makeCaller(ctx.event);
  courseA = (await caller.course.create({ name: "A" })).id;
  courseB = (await caller.course.create({ name: "B" })).id;
  classA = (await caller.class.create({ name: "H21", courseId: courseA })).id;
  classPool = (await caller.class.create({ name: "D21" })).id;
  // D21 forks over A and B.
  const pool = await ctx.db.class.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: classPool } });
  for (const seq of [courseA, courseB]) {
    const c = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq } });
    await ctx.db.classCoursePool.create({ data: { classId: pool.id, courseId: c.id } });
  }
});

afterAll(async () => {
  await ctx.db.user.deleteMany({ where: { email: { endsWith: `@d2-objects-${suffix}.example` } } });
  await ctx.cleanup();
  await disconnect();
});

describe("courseObject CRUD", () => {
  it("creates every phase-1 kind and lists them in draw order with public ids", async () => {
    const bodies: Omit<course.CourseObject, "id" | "version" | "z" | "scope">[] = [
      { kind: "oob_area", geometry: SQUARE, props: { border: "solid" } },
      { kind: "oob_line", geometry: SQUARE.slice(0, 2), props: { symbol: "711" } },
      { kind: "whiteout", geometry: SQUARE, props: {} },
      { kind: "toner_saver", geometry: SQUARE, props: { marginMm: 5 } },
      { kind: "marked_route", geometry: [{ x: 0, y: 0, hOut: { x: 1, y: 1 } }, { x: 5, y: 5 }], props: {} },
      { kind: "text", geometry: [{ x: 1, y: 2 }], props: { text: "Ingen passage", fontSizeMm: 3 } },
      { kind: "image", geometry: [{ x: 0, y: 0 }, { x: 10, y: 5 }], props: { graphicId: 3 } },
      { kind: "filter_region", geometry: SQUARE, props: { mode: "hide", symbols: [4, 5], invert: true } },
    ];
    const made: course.CourseObject[] = [];
    for (const [i, b] of bodies.entries()) {
      made.push(await caller.courseObject.create({ ...b, scope: i === 0 ? { courses: [courseA], classes: [classPool] } : { all: true }, z: 10 - i } as never));
    }
    expect(made[0]).toMatchObject({ kind: "oob_area", props: { border: "solid" }, scope: { courses: [courseA], classes: [classPool] }, z: 10 });
    expect(made[0].version).toMatch(/^\d+$/);
    expect(made[0].version).not.toBe("0");
    const stored = await ctx.db.courseObject.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: made[0].id } });
    const a = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: courseA } });
    expect((stored.scope as { courses: string[] }).courses).toEqual([a.id]);
    expect(stored.version.toString()).toBe(made[0].version);

    const list = await caller.courseObject.list();
    expect(list.map((o) => o.kind)).toEqual([...bodies.map((b) => b.kind)].reverse());
    expect(list.find((o) => o.kind === "filter_region")).toMatchObject({ geometry: SQUARE, props: { mode: "hide", symbols: [4, 5], invert: true } });
  });

  it("refuses inset_frame, an unknown course or class in the scope, and a bad body", async () => {
    await expect(caller.courseObject.create({ kind: "inset_frame", geometry: SQUARE.slice(0, 2), props: {}, scope: { all: true } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.courseObject.create({ kind: "whiteout", geometry: SQUARE, props: {}, scope: { courses: [9999], classes: [] } })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("course 9999") });
    await expect(caller.courseObject.create({ kind: "whiteout", geometry: SQUARE, props: {}, scope: { courses: [], classes: [8888] } })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("class 8888") });
    await expect(caller.courseObject.create({ kind: "oob_area", geometry: SQUARE.slice(0, 2), props: {}, scope: { all: true } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("update replaces geometry / props / scope and advances the token; the kind's rules still hold", async () => {
    const o = await caller.courseObject.create({ kind: "oob_area", geometry: SQUARE, props: {}, scope: { all: true } });
    const moved = await caller.courseObject.update({ id: o.id, baseVersion: o.version, geometry: SQUARE.map((p) => ({ x: p.x + 1, y: p.y })), props: { border: "dashed" }, scope: { courses: [courseB], classes: [] } });
    expect(moved).toMatchObject({ id: o.id, kind: "oob_area", props: { border: "dashed" }, scope: { courses: [courseB], classes: [] } });
    expect(moved.geometry[0]).toEqual({ x: 11, y: 10 });
    expect(BigInt(moved.version)).toBeGreaterThan(BigInt(o.version));
    await expect(caller.courseObject.update({ id: o.id, props: { symbol: "711" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.courseObject.update({ id: 99999, props: {} })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a stale token is a CONFLICT with the object now and nothing written; no token is last-write-wins", async () => {
    const o = await caller.courseObject.create({ kind: "whiteout", geometry: SQUARE, props: {}, scope: { all: true } });
    const other = await caller.courseObject.update({ id: o.id, baseVersion: o.version, z: 5 });
    const data = await conflictOf(caller.courseObject.update({ id: o.id, baseVersion: o.version, geometry: SQUARE.slice(0, 3) }));
    expect(data).toMatchObject({ kind: "object", id: o.id, version: other.version, differing: null });
    expect(data.current).toMatchObject({ id: o.id, z: 5, geometry: SQUARE });
    const row = await ctx.db.courseObject.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: o.id } });
    expect(row.geometry).toEqual(SQUARE);

    const lww = await caller.courseObject.update({ id: o.id, geometry: SQUARE.slice(0, 3) });
    expect(lww.geometry).toHaveLength(3);

    const del = await conflictOf(caller.courseObject.delete({ id: o.id, baseVersion: o.version }));
    expect(del.version).toBe(lww.version);
    await caller.courseObject.delete({ id: o.id, baseVersion: lww.version });
    expect(await ctx.db.courseObject.count({ where: { eventId: ctx.eventId, seq: o.id } })).toBe(0);
  });

  it("reorder sets z by position and leaves the tokens", async () => {
    const list = await caller.courseObject.list();
    const ids = list.map((o) => o.id).reverse();
    const after = await caller.courseObject.reorder({ ids });
    expect(after.map((o) => o.id)).toEqual(ids);
    expect(after.map((o) => o.z)).toEqual(ids.map((_, i) => i));
    for (const o of after) expect(o.version).toBe(list.find((l) => l.id === o.id)!.version);
    await expect(caller.courseObject.reorder({ ids: [ids[0], ids[0]] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.courseObject.reorder({ ids: [99999] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("access", () => {
  it("a kiosk key reads the objects; a viewer cannot write", async () => {
    await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: `k-${suffix}` } });
    const kiosk = makeCaller({ ...ctx.event, kioskKey: `k-${suffix}` }, { user: null, authEnabled: true, authMode: "proxy", kioskKey: `k-${suffix}` });
    expect((await kiosk.courseObject.list()).length).toBeGreaterThan(0);
    await expect(kiosk.courseObject.create({ kind: "whiteout", geometry: SQUARE, props: {}, scope: { all: true } })).rejects.toBeInstanceOf(TRPCError);

    const viewer = await ctx.db.user.create({ data: { email: `viewer@d2-objects-${suffix}.example`, displayName: "Viewer", isAdmin: false, active: true } });
    const group = await ctx.db.permissionGroup.create({ data: { name: `Viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
    await ctx.db.eventPermission.create({ data: { eventId: ctx.eventId, userId: viewer.id, groupId: group.id } });
    const asViewer = makeCaller(ctx.event, { user: viewer, authEnabled: true, identityEmail: viewer.email });
    expect((await asViewer.courseObject.list()).length).toBeGreaterThan(0);
    await expect(asViewer.courseObject.create({ kind: "whiteout", geometry: SQUARE, props: {}, scope: { all: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await ctx.db.eventPermission.deleteMany({ where: { groupId: group.id } });
    await ctx.db.permissionGroup.delete({ where: { id: group.id } });
  });
});

describe("scope over the event's classes (§8.2)", () => {
  it("a class scope reaches the course through classes.course_id and the forking pool", async () => {
    const byClassA = await caller.courseObject.create({ kind: "whiteout", geometry: SQUARE, props: {}, scope: { courses: [], classes: [classA] } });
    const byPool = await caller.courseObject.create({ kind: "whiteout", geometry: SQUARE, props: {}, scope: { courses: [], classes: [classPool] } });
    const objects = await loadCourseObjects(ctx.db, ctx.eventId);
    const byCourse = await classesByCourse(ctx.db, ctx.eventId);
    const uuidOf = async (seq: number) => (await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq } })).id;
    const seqs = (list: { seq: number }[]) => list.map((o) => o.seq);
    const inA = seqs(objectsInScope(objects, await uuidOf(courseA), byCourse));
    const inB = seqs(objectsInScope(objects, await uuidOf(courseB), byCourse));
    const none = objectsInScope(objects, null, byCourse);
    expect(inA).toEqual(expect.arrayContaining([byClassA.id, byPool.id]));
    expect(inB).toContain(byPool.id);
    expect(inB).not.toContain(byClassA.id);
    expect(none.every((o) => "all" in o.scope)).toBe(true);
    expect(none.length).toBeGreaterThan(0);
  });
});

describe("checkout snapshot (map-storage.md §7.2)", () => {
  it("carries the rows verbatim: UUIDs, seq, scope UUIDs, token", async () => {
    const before = await ctx.db.courseObject.findMany({ where: { eventId: ctx.eventId }, orderBy: { seq: "asc" } });
    expect(before.length).toBeGreaterThan(0);
    const snapshot = await exportEventSnapshot(ctx.db, ctx.event);
    expect(snapshot.tables.courseObject).toHaveLength(before.length);
    const copyName = `${ctx.event.nameId}_copy`;
    snapshot.event = { ...snapshot.event, nameId: copyName };
    // The ids travel verbatim, so the copy can only exist once the original is gone.
    await ctx.db.courseObject.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.course.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.class.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.control.deleteMany({ where: { eventId: ctx.eventId } });
    const local = await importEventSnapshot(ctx.db, snapshot);
    try {
      const after = await ctx.db.courseObject.findMany({ where: { eventId: local.id }, orderBy: { seq: "asc" } });
      expect(after.map(({ eventId: _e, ...r }) => r)).toEqual(before.map(({ eventId: _e, ...r }) => r));
    } finally {
      await ctx.db.event.delete({ where: { id: local.id } });
    }
  });
});
