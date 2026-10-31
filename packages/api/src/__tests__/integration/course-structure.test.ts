/**
 * Course structure and concurrency (slice D, row D0; docs/course-layer.md
 * §6 "Structure", §7 "Concurrency"):
 *
 *   - course.setStructure writes the column and its mirror (course_controls,
 *     start / finish columns, number_hidden, label offsets) and the same
 *     geometry the linear course.update path writes
 *   - course.update { controlIds } (the linear shortcut) writes a structure
 *   - the version token is the HLC of the row's last write entry, journaled
 *     with the structure
 *   - a stale baseVersion is a CONFLICT carrying the server's row and what
 *     differs; course and control tokens are separate
 *   - control.check, kind ↔ status sync, control.delete pruning the structure
 *   - courses.review: controller notes / check-off without courses.edit
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import { versionConflictOf, type VersionConflictData } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { VersionConflictError } from "../../version-conflict.js";
import type { AuthUser } from "../../auth.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
// Public ids of the start / finish (code-less: their seq).
let startSeq: number;
let finishSeq: number;

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

async function courseRow(seq: number) {
  return ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq } });
}

async function ccOf(seq: number) {
  const c = await courseRow(seq);
  return ctx.db.courseControl.findMany({
    where: { courseId: c.id },
    orderBy: { position: "asc" },
    include: { control: { select: { codes: true } } },
  });
}

beforeAll(async () => {
  ctx = await createTestEvent("course_structure");
  caller = makeCaller(ctx.event);
  startSeq = (await caller.control.create({ status: 4, xpos: 10, ypos: 10 })).id;
  finishSeq = (await caller.control.create({ status: 5, xpos: 90, ypos: 10 })).id;
  for (const [code, x] of [[31, 30], [32, 50], [33, 70], [34, 60]] as const) {
    await caller.control.create({ codes: String(code), xpos: x, ypos: 20 });
  }
});

afterAll(async () => {
  await ctx.db.user.deleteMany({ where: { email: { endsWith: "@d0-structure.example" } } });
  await ctx.cleanup();
  await disconnect();
});

describe("kind ↔ status", () => {
  it("creates start / finish rows with the matching kind", async () => {
    const list = await caller.control.list();
    expect(list.find((c) => c.id === startSeq)).toMatchObject({ kind: "start", status: 4 });
    expect(list.find((c) => c.id === finishSeq)).toMatchObject({ kind: "finish", status: 5 });
    expect(list.find((c) => c.id === 31)).toMatchObject({ kind: "control", notes: "", circleGaps: [], checkedAt: null });
  });

  it("keeps status 4 / 5 in sync when kind is written, and kind when status is", async () => {
    const c = await caller.control.create({ codes: "90", xpos: 5, ypos: 5 });
    await caller.control.update({ id: c.id, kind: "start" });
    let row = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "90" } });
    expect([row.kind, row.status]).toEqual(["start", "start"]);
    await caller.control.update({ id: c.id, status: 0 });
    row = await ctx.db.control.findFirstOrThrow({ where: { id: row.id } });
    expect([row.kind, row.status]).toEqual(["control", "ok"]);
    await caller.control.delete({ id: c.id });
  });

  it("refuses the slice-F kinds", async () => {
    await expect(caller.control.update({ id: 31, kind: "map_exchange" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("stores circle gaps", async () => {
    await caller.control.update({ id: 34, circleGaps: [{ start: 10, end: 50 }] });
    const list = await caller.control.list();
    expect(list.find((c) => c.id === 34)?.circleGaps).toEqual([{ start: 10, end: 50 }]);
  });
});

describe("course.update writes a structure (the linear shortcut)", () => {
  it("names the course_controls, leaves the event default start / finish implicit, journals it", async () => {
    const { id } = await caller.course.create({ name: "Linear", controlIds: [31, 32] });
    const before = await courseRow(id);
    const res = await caller.course.update({ id, controlIds: [31, 32, 33] });
    const row = await courseRow(id);
    expect(row.structure).toMatchObject({ version: 1, id: row.id, orderMode: "ordered" });
    const items = (row.structure as { items: { siteId: string }[] }).items;
    const ccs = await ccOf(id);
    expect(items.map((i) => i.siteId)).toEqual(ccs.map((cc) => cc.controlId));
    expect(row.version > before.version).toBe(true);
    expect(res.version).toBe(row.version.toString());

    const entry = await ctx.db.journalEntry.findFirstOrThrow({
      where: { eventId: ctx.eventId, type: "course.upserted", hlc: row.version },
    });
    const payload = entry.payload as { id: string; fields: Record<string, unknown> };
    expect(payload.id).toBe(row.id);
    expect(payload.fields.structure).toEqual(row.structure);
    expect(payload.fields.version).toBe(row.version.toString());
    expect(payload.fields).not.toHaveProperty("geometry");

    const detail = await caller.course.detail({ id });
    expect(detail.version).toBe(row.version.toString());
    expect(detail.structureStored).toBe(true);
    expect(detail.structure.items.map((i) => ("siteId" in i ? i.siteId : null))).toEqual([31, 32, 33]);
    const listed = (await caller.course.list()).find((c) => c.id === id);
    expect(listed?.version).toBe(row.version.toString());
  });

  it("reads a course written before D0 (structure NULL) as the structure its columns describe", async () => {
    const { id } = await caller.course.create({ name: "Old", controlIds: [31] });
    const row = await courseRow(id);
    await ctx.db.$executeRaw`UPDATE oxygen.courses SET structure = NULL, start_name = 'Start 1' WHERE id = ${row.id}::uuid`;
    const detail = await caller.course.detail({ id });
    expect(detail.structureStored).toBe(false);
    expect(detail.structure.items.map((i) => ("siteId" in i ? i.siteId : null))).toEqual([startSeq, 31]);
  });
});

describe("course.setStructure", () => {
  it("writes the column and its mirror: explicit start / finish, sequence, hidden numbers, label offsets", async () => {
    const { id } = await caller.course.create({ name: "Structured" });
    const res = await caller.course.setStructure({
      courseId: id,
      structure: {
        version: 1,
        id: "ignored",
        orderMode: "ordered",
        items: [
          { siteId: startSeq },
          { siteId: 31 },
          { siteId: 33, numberHidden: true, leg: { gaps: [{ from: 0.4, to: 0.5 }] } },
          { siteId: finishSeq },
        ],
        labelOffsets: { "33": { dx: 2, dy: -1 } },
      },
    });
    expect(res.checks).toEqual([]);
    const row = await courseRow(id);
    const start = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: startSeq } });
    const finish = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: finishSeq } });
    expect(row.startName).toBe(start.name);
    expect(row.finishControlId).toBe(finish.id);
    expect(row.version.toString()).toBe(res.version);
    const ccs = await ccOf(id);
    expect(ccs.map((cc) => cc.control.codes)).toEqual(["31", "33"]);
    expect(ccs.map((cc) => cc.numberHidden)).toEqual([false, true]);
    expect([ccs[1].labelDx, ccs[1].labelDy]).toEqual([2, -1]);
    // The column holds no label offsets (course_controls is their one source).
    expect(row.structure).not.toHaveProperty("labelOffsets");
    const detail = await caller.course.detail({ id });
    expect(detail.structure.labelOffsets).toEqual({ "33": { dx: 2, dy: -1 } });
    expect(detail.structure.items[2]).toMatchObject({ siteId: 33, leg: { gaps: [{ from: 0.4, to: 0.5 }] } });
  });

  it("writes the same geometry the linear course.update path writes", async () => {
    const a = await caller.course.create({ name: "Geo A" });
    const b = await caller.course.create({ name: "Geo B" });
    await caller.course.update({ id: a.id, controlIds: [31, 32, 33] });
    await caller.course.setStructure({
      courseId: b.id,
      structure: { version: 1, id: "b", orderMode: "ordered", items: [{ siteId: 31 }, { siteId: 32 }, { siteId: 33 }] },
    });
    const ra = await courseRow(a.id);
    const rb = await courseRow(b.id);
    // Byte-identical but for the course's own id.
    const json = (g: unknown, own: string) => JSON.stringify(g).replaceAll(own, "<course>");
    expect((ra.geometry as { features: unknown[] }).features.length).toBeGreaterThan(0);
    expect(json(rb.geometry, rb.id)).toBe(json(ra.geometry, ra.id));
    expect(rb.legs).toBe(ra.legs);
  });

  it("refuses variation groups (slice F) and unknown controls", async () => {
    const { id } = await caller.course.create({ name: "Var" });
    await expect(
      caller.course.setStructure({
        courseId: id,
        structure: {
          version: 1,
          id: "v",
          orderMode: "ordered",
          items: [
            { siteId: 31 },
            { kind: "variation", id: "g", alternatives: [{ label: "A", items: [{ siteId: 32 }] }, { label: "B", items: [{ siteId: 33 }] }] },
            { siteId: 34 },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      caller.course.setStructure({ courseId: id, structure: { version: 1, id: "v", orderMode: "ordered", items: [{ siteId: 999 }] } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("concurrency (course-layer.md §7)", () => {
  it("refuses a stale course token with the server's structure and the differing items", async () => {
    const { id } = await caller.course.create({ name: "Race", controlIds: [31, 32] });
    const v0 = (await caller.course.detail({ id })).version;
    const v1 = (await caller.course.update({ id, controlIds: [31, 32, 33], baseVersion: v0 })).version;
    const conflict = await conflictOf(caller.course.update({ id, controlIds: [32, 31], baseVersion: v0 }));
    expect(conflict).toMatchObject({ kind: "course", id, version: v1 });
    expect((conflict.current as { items: { siteId: number }[] }).items.map((i) => i.siteId)).toEqual([31, 32, 33]);
    expect(conflict.differing).toEqual(["33"]);
    // Nothing was written.
    expect((await ccOf(id)).map((cc) => cc.control.codes)).toEqual(["31", "32", "33"]);
    await expect(
      caller.course.setStructure({ courseId: id, structure: { version: 1, id: "x", orderMode: "ordered", items: [] }, baseVersion: v0 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Without a token: last write wins, as before D0.
    await caller.course.update({ id, controlIds: [32] });
    expect((await ccOf(id)).map((cc) => cc.control.codes)).toEqual(["32"]);
  });

  it("refuses a stale control token, naming the fields that differ", async () => {
    const before = (await caller.control.list()).find((c) => c.id === 32)!;
    const moved = await caller.control.update({ id: 32, xpos: 51, ypos: 21, baseVersion: before.version });
    const conflict = await conflictOf(caller.control.update({ id: 32, xpos: 52, ypos: 22, baseVersion: before.version }));
    expect(conflict).toMatchObject({ kind: "control", id: 32, version: moved.version, differing: ["xpos", "ypos"] });
    expect(conflict.current).toMatchObject({ xpos: 51, ypos: 21 });
    expect(conflict.differing).not.toContain("notes");
  });

  it("reports differing as null when the base entry is not on this node (token 0)", async () => {
    const conflict = await conflictOf(caller.control.update({ id: 33, name: "x", baseVersion: "0" }));
    expect(conflict.differing).toBeNull();
  });

  it("keeps separate tokens: a control move leaves its courses' tokens, a course edit leaves the controls'", async () => {
    const { id } = await caller.course.create({ name: "Tokens", controlIds: [31, 33] });
    const course0 = (await courseRow(id)).version;
    const control0 = (await caller.control.list()).find((c) => c.id === 33)!.version;
    await caller.control.update({ id: 33, xpos: 71, ypos: 20 });
    expect((await courseRow(id)).version).toBe(course0);
    // ...though the course's geometry was rebuilt and re-journaled.
    const control1 = (await caller.control.list()).find((c) => c.id === 33)!.version;
    expect(control1).not.toBe(control0);
    await caller.course.update({ id, controlIds: [33, 31] });
    expect((await caller.control.list()).find((c) => c.id === 33)!.version).toBe(control1);
  });
});

describe("control.delete prunes the structure of the courses that visit it", () => {
  it("drops the item and advances the course token", async () => {
    const tmp = await caller.control.create({ codes: "77", xpos: 40, ypos: 40 });
    const { id } = await caller.course.create({ name: "Prune" });
    await caller.course.setStructure({
      courseId: id,
      structure: { version: 1, id: "p", orderMode: "ordered", items: [{ siteId: 31 }, { siteId: 77 }, { siteId: 32, leg: { gaps: [{ from: 0.1, to: 0.2 }] } }] },
    });
    const v0 = (await courseRow(id)).version;
    await caller.control.delete({ id: tmp.id });
    const row = await courseRow(id);
    expect(row.version > v0).toBe(true);
    const detail = await caller.course.detail({ id });
    expect(detail.structure.items.map((i) => ("siteId" in i ? i.siteId : null))).toEqual([31, 32]);
  });
});

describe("control.check and courses.review", () => {
  const suffix = randomBytes(4).toString("hex");
  let controller: AuthUser;
  let groupId: string;

  beforeAll(async () => {
    controller = await ctx.db.user.create({
      data: { email: `controller-${suffix}@d0-structure.example`, displayName: "Controller", isAdmin: false, active: true },
    });
    const group = await ctx.db.permissionGroup.create({
      data: { name: `Controller ${suffix}`, capabilities: ["event.view", "courses.view", "courses.review"] },
    });
    groupId = group.id;
    await ctx.db.eventPermission.create({ data: { eventId: ctx.eventId, userId: controller.id, groupId } });
  });

  afterAll(async () => {
    await ctx.db.eventPermission.deleteMany({ where: { groupId } });
    await ctx.db.permissionGroup.delete({ where: { id: groupId } });
  });

  const asController = () =>
    makeCaller(ctx.event, { user: controller, authEnabled: true, identityEmail: controller.email });

  it("the seeded course-setter and event-admin groups hold courses.review", async () => {
    const groups = await ctx.db.permissionGroup.findMany({ where: { isSystem: true } });
    const caps = Object.fromEntries(groups.map((g) => [g.name, g.capabilities as string[]]));
    expect(caps["Course setter"]).toContain("courses.review");
    expect(caps["Event admin"]).toContain("courses.review");
    expect(caps["Race crew"]).not.toContain("courses.review");
  });

  it("a controller checks off a control and writes notes, but cannot move it", async () => {
    const before = (await caller.control.list()).find((c) => c.id === 31)!;
    const { version } = await asController().control.check({ controlId: 31, checked: true });
    let row = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "31" } });
    expect(row.checkedAt).not.toBeNull();
    expect(row.checkedBy).toBe(controller.id);
    expect(version).toBe(row.version.toString());
    expect(version).not.toBe(before.version);

    await asController().control.update({ id: 31, notes: "Flag on the north side" });
    row = await ctx.db.control.findFirstOrThrow({ where: { id: row.id } });
    expect(row.notes).toBe("Flag on the north side");

    await expect(asController().control.update({ id: 31, xpos: 1, ypos: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(asController().control.update({ id: 31, notes: "x", name: "y" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await asController().control.check({ controlId: 31, checked: false });
    row = await ctx.db.control.findFirstOrThrow({ where: { id: row.id } });
    expect([row.checkedAt, row.checkedBy]).toEqual([null, null]);
  });
});

describe("the mirror stays a function of the structure (course-layer.md §6.2)", () => {
  it("re-mirrors a stored structure when a visited site's kind changes, and advances the course token", async () => {
    const site = await caller.control.create({ codes: "81", xpos: 15, ypos: 15 });
    await ctx.db.control.updateMany({ where: { eventId: ctx.eventId, codes: "81" }, data: { name: "Start K" } });
    const { id } = await caller.course.create({ name: "Kind" });
    await caller.course.setStructure({
      courseId: id,
      structure: { version: 1, id: "k", orderMode: "ordered", items: [{ siteId: site.id }, { siteId: 31 }, { siteId: 32 }] },
    });
    const v0 = (await courseRow(id)).version;
    expect((await ccOf(id)).map((cc) => cc.control.codes)).toEqual(["81", "31", "32"]);

    await caller.control.update({ id: site.id, kind: "start" });
    const row = await courseRow(id);
    // The site now leads the course as its explicit start: out of course_controls, into start_name.
    expect(row.startName).toBe("Start K");
    expect((await ccOf(id)).map((cc) => cc.control.codes)).toEqual(["31", "32"]);
    expect(row.version > v0).toBe(true);
    const seq = (row.geometry as { features: { properties: { symbolType?: string; code?: string } }[] }).features
      .filter((f) => f.properties.symbolType === "start")
      .map((f) => f.properties.code);
    expect(seq).toEqual(["81"]);

    await caller.control.update({ id: site.id, kind: "control" });
    expect((await ccOf(id)).map((cc) => cc.control.codes)).toEqual(["81", "31", "32"]);
    expect((await courseRow(id)).startName).toBe("");
  });

  it("drops a deleted explicit start from the structure and advances the token", async () => {
    const extra = await caller.control.create({ status: 4, xpos: 11, ypos: 11 });
    const { id } = await caller.course.create({ name: "Lost start" });
    await caller.course.setStructure({
      courseId: id,
      structure: { version: 1, id: "s", orderMode: "ordered", items: [{ siteId: extra.id }, { siteId: 31 }] },
    });
    const v0 = (await courseRow(id)).version;
    const res = await caller.control.delete({ id: extra.id });
    const row = await courseRow(id);
    expect(row.version > v0).toBe(true);
    expect(res.courses).toContainEqual({ id, version: row.version.toString() });
    const detail = await caller.course.detail({ id });
    expect(detail.structure.items.map((i) => ("siteId" in i ? i.siteId : null))).toEqual([31]);
    expect(row.startName).toBe("");
  });

  it("course.clone copies the structure (legs included); bulkUpdate rewrites it from the columns", async () => {
    const { id } = await caller.course.create({ name: "Clone src" });
    await caller.course.setStructure({
      courseId: id,
      structure: { version: 1, id: "c", orderMode: "ordered", items: [{ siteId: 31 }, { siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }] } }] },
    });
    const clone = await caller.course.clone({ id, name: "Clone dst" });
    const src = await courseRow(id);
    const dst = await courseRow(clone.id);
    expect({ ...(dst.structure as object), id: "_" }).toEqual({ ...(src.structure as object), id: "_" });
    expect((dst.structure as { id: string }).id).toBe(dst.id);
    expect(clone.version).toBe(dst.version.toString());

    await caller.course.bulkUpdate({ ids: [clone.id], firstAsStart: true });
    const after = await courseRow(clone.id);
    const items = (after.structure as { items: { siteId: string; role?: string; leg?: unknown }[] }).items;
    expect(items[0].role).toBe("start");
    expect(items[1].leg).toEqual({ gaps: [{ from: 0.2, to: 0.3 }] });
  });
});

describe("differing names label-offset changes", () => {
  it("reports the site whose number moved since the client's base", async () => {
    const { id } = await caller.course.create({ name: "Labels", controlIds: [31, 32] });
    const base = (await caller.course.detail({ id })).version;
    const moved = await caller.course.setControlLabelOffset({ id, controlId: 32, offset: { dx: 3, dy: 1 } });
    expect(moved.version).toBe((await courseRow(id)).version.toString());
    const conflict = await conflictOf(caller.course.update({ id, controlIds: [32, 31], baseVersion: base }));
    expect(conflict.differing).toEqual(["32"]);
  });
});
