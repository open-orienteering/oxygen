/**
 * Leg routes (docs/course-elevation.md §7): a route per directed control
 * pair, shared by the courses running the pair; one chosen route per
 * pair; the stored computed climb follows the chosen route and is
 * cleared and computed again by every change of it; a typed climb, a
 * marked route and the course's length are untouched.
 *
 * Fixture: the hill of `course-climb.test.ts` (rings of 5–20 mm around
 * (30, 30) at 1:15 000) with two controls south and north of it, so the
 * straight leg between them runs over the top and a route around it is
 * flat.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "crypto";
import { mapDocument } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { HILL, encodeTerrainDoc } from "../helpers/terrain-doc.js";
import { deriveDocumentHeightfield } from "../../map-store/heightfield.js";
import { resetClimbFields } from "../../course-climb.js";
import { BACKUP_TABLES } from "../../backup.js";
import { exportEventSnapshot, importEventSnapshot } from "../../sync/lease.js";

const suffix = randomBytes(4).toString("hex");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let ctx: TestEventContext;
let other: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let south: number;
let north: number;
let over: number;
let second: number;
let back: number;

const rowOf = (seq: number) => ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq } });
const climbOf = async (seq: number) => { const r = await rowOf(seq); return { m: r.climbM, source: r.climbSource }; };
/** Along the hill's lowest ring, east of the top: no way over it. */
const AROUND = [{ x: 49, y: 30 }];

beforeAll(async () => {
  resetClimbFields();
  ctx = await createTestEvent("leg_routes");
  other = await createTestEvent("leg_routes_other");
  caller = makeCaller(ctx.event);
  const sourceBytes = Buffer.from(`leg-routes-source-${suffix}`);
  const sourceHash = sha(sourceBytes);
  await ctx.db.mapSource.create({ data: { fileHash: sourceHash, kind: "ocad", bytes: sourceBytes, sizeBytes: sourceBytes.byteLength, fileName: "synthetic.ocd" } });
  const bytes = encodeTerrainDoc(HILL, `routes-${suffix}`, sourceHash);
  const hash = sha(bytes);
  const { header } = mapDocument.readMapDocumentHeader(bytes);
  await ctx.db.mapDocument.create({
    data: {
      hash, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "test", libraryVersion: "none", sourceHash,
      header: JSON.parse(JSON.stringify({ ...header, symbols: undefined, strings: undefined })), report: {},
    },
  });
  await ctx.db.mapFile.create({ data: { eventId: ctx.eventId, fileName: "synthetic.ocd", sourceHash, documentHash: hash, scale: 15000, contourIntervalM: 5 } });
  await deriveDocumentHeightfield(ctx.db, hash);
  await caller.control.create({ status: 4, xpos: 12, ypos: 12 });
  await caller.control.create({ status: 5, xpos: 48, ypos: 48 });
  south = (await caller.control.create({ codes: "41", xpos: 30, ypos: 11 })).id;
  north = (await caller.control.create({ codes: "42", xpos: 30, ypos: 49 })).id;
  over = (await caller.course.create({ name: "Over", controlIds: [south, north] })).id;
  second = (await caller.course.create({ name: "Second", controlIds: [south, north] })).id;
  back = (await caller.course.create({ name: "Back", controlIds: [north, south] })).id;
});

afterAll(async () => {
  await ctx.cleanup();
  await other.cleanup();
  await disconnect();
});

describe("leg routes (docs/course-elevation.md §7)", () => {
  let straight: { m: number; source: string | null };
  let routeId: string;

  it("without a route the climb is read along the drawn line, over the hill", async () => {
    straight = await climbOf(over);
    expect(straight.source).toBe("computed");
    expect(straight.m).toBeGreaterThanOrEqual(15);
    expect(await caller.legRoute.list()).toEqual([]);
  });

  it("a saved route is chosen, and every course running the pair is read along it; the length stays", async () => {
    const lengthBefore = (await rowOf(over)).lengthM;
    const r = await caller.legRoute.save({ fromControlId: south, toControlId: north, points: AROUND });
    routeId = r.id;
    expect(r).toMatchObject({ fromControlId: south, toControlId: north, points: AROUND, source: "drawn", model: null, chosen: true });
    for (const id of [over, second]) {
      const c = await climbOf(id);
      expect(c.m, "around the hill, not over it").toBeLessThanOrEqual(straight.m - 4);
      expect(c.m === 0 ? null : c.source).toBe(c.m === 0 ? null : "computed");
    }
    expect((await rowOf(over)).lengthM).toBe(lengthBefore);
    expect(await caller.legRoute.list()).toEqual([r]);
  });

  it("a route is directed: the pair run the other way keeps its line", async () => {
    expect((await climbOf(back)).m).toBeGreaterThanOrEqual(15);
  });

  it("taking the choice away reads the pair along its line again; choosing brings the route back", async () => {
    const routed = await climbOf(over);
    expect((await caller.legRoute.choose({ id: routeId, chosen: false })).chosen).toBe(false);
    expect(await climbOf(over)).toEqual(straight);
    await caller.legRoute.choose({ id: routeId, chosen: true });
    expect(await climbOf(over)).toEqual(routed);
  });

  it("one chosen route per pair: a second route takes the choice, an unchosen one changes nothing", async () => {
    const routed = await climbOf(over);
    // Over the top, as the line runs.
    const b = await caller.legRoute.save({ fromControlId: south, toControlId: north, points: [{ x: 30, y: 30 }] });
    const list = await caller.legRoute.list();
    expect(list.map((r) => [r.id, r.chosen])).toEqual([[routeId, false], [b.id, true]]);
    expect((await climbOf(over)).m).toBeGreaterThanOrEqual(15);
    const c = await caller.legRoute.save({ fromControlId: south, toControlId: north, points: [{ x: 4, y: 30 }], chosen: false, source: "computed", model: "default-1" });
    expect(c).toMatchObject({ chosen: false, source: "computed", model: "default-1" });
    expect((await caller.legRoute.list()).filter((r) => r.chosen).map((r) => r.id)).toEqual([b.id]);
    // The index holds it too.
    await expect(ctx.db.legRoute.update({ where: { id: c.id }, data: { chosen: true } })).rejects.toThrow();
    await caller.legRoute.choose({ id: routeId, chosen: true });
    expect((await caller.legRoute.list()).filter((r) => r.chosen).map((r) => r.id)).toEqual([routeId]);
    expect(await climbOf(over)).toEqual(routed);
    await caller.legRoute.delete({ id: b.id });
    await caller.legRoute.delete({ id: c.id });
    expect(await climbOf(over)).toEqual(routed);
  });

  it("new points for a route are stored and the climb follows", async () => {
    const routed = await climbOf(over);
    const r = await caller.legRoute.save({ id: routeId, fromControlId: south, toControlId: north, points: [{ x: 30, y: 30 }] });
    expect(r).toMatchObject({ id: routeId, chosen: true, points: [{ x: 30, y: 30 }] });
    expect((await climbOf(over)).m).toBeGreaterThanOrEqual(15);
    await caller.legRoute.save({ id: routeId, fromControlId: south, toControlId: north, points: AROUND });
    expect(await climbOf(over)).toEqual(routed);
    await expect(caller.legRoute.save({ id: routeId, fromControlId: north, toControlId: south, points: AROUND })).rejects.toThrow(/keeps its pair/);
  });

  it("a typed climb stays; a marked route is its own route", async () => {
    await caller.course.update({ id: second, climb: 88 });
    await caller.legRoute.choose({ id: routeId, chosen: false });
    await caller.legRoute.choose({ id: routeId, chosen: true });
    expect(await climbOf(second)).toEqual({ m: 88, source: "manual" });
    await caller.course.update({ id: second, climb: null });
    const routed = await climbOf(second);
    const detail = await caller.course.detail({ id: second });
    const structure = detail.structure as { items: { siteId: number; leg?: Record<string, unknown> }[] };
    const items = structure.items.map((i) => (i.siteId === north ? { ...i, leg: { ...(i.leg ?? {}), style: "marked_route" } } : i));
    await caller.course.setStructure({ courseId: second, structure: { ...structure, items } as never });
    expect(await climbOf(second), "the marked leg is read along its own line").toEqual(straight);
    await caller.course.setStructure({ courseId: second, structure: structure as never });
    expect(await climbOf(second)).toEqual(routed);
  });

  it("a control run to twice: the marked leg keeps its line, the other leg its route", async () => {
    const extra = (await caller.control.create({ codes: "44", xpos: 46, ypos: 46 })).id;
    const twice = (await caller.course.create({ name: "Twice", controlIds: [south, north, extra, north] })).id;
    const plain = await climbOf(twice);
    await caller.legRoute.choose({ id: routeId, chosen: false });
    const unrouted = await climbOf(twice);
    await caller.legRoute.choose({ id: routeId, chosen: true });
    expect(plain.m).toBeLessThanOrEqual(unrouted.m - 4);
    // The second run to `north` (from `extra`) is a marked route; south → north is not.
    const detail = await caller.course.detail({ id: twice });
    const structure = detail.structure as { items: { siteId: number; leg?: Record<string, unknown> }[] };
    const last = structure.items.map((i) => i.siteId).lastIndexOf(north);
    const items = structure.items.map((i, at) => (at === last ? { ...i, leg: { ...(i.leg ?? {}), style: "marked_route" } } : i));
    await caller.course.setStructure({ courseId: twice, structure: { ...structure, items } as never });
    expect(await climbOf(twice), "south → north is still read along its route").toEqual(plain);
    await caller.course.delete({ id: twice });
    await caller.control.delete({ id: extra });
  });

  it("a moved control keeps the route's vertices: the ends follow", async () => {
    await caller.control.update({ id: south, xpos: 32, ypos: 11 });
    const [r] = await caller.legRoute.list();
    expect(r.points).toEqual(AROUND);
    expect((await climbOf(over)).m).toBeLessThanOrEqual(straight.m - 4);
    await caller.control.update({ id: south, xpos: 30, ypos: 11 });
  });

  it("refused: the same control twice, an unknown control, no points, another event's route", async () => {
    await expect(caller.legRoute.save({ fromControlId: south, toControlId: south, points: AROUND })).rejects.toThrow(/two different controls/);
    await expect(caller.legRoute.save({ fromControlId: south, toControlId: 99999, points: AROUND })).rejects.toThrow(/not found/);
    await expect(caller.legRoute.save({ fromControlId: south, toControlId: north, points: [] })).rejects.toThrow();
    const stranger = makeCaller(other.event);
    await expect(stranger.legRoute.choose({ id: routeId, chosen: false })).rejects.toThrow(/not found/);
    await expect(stranger.legRoute.delete({ id: routeId })).rejects.toThrow(/not found/);
    expect(await stranger.legRoute.list()).toEqual([]);
  });

  it("a removed control's routes are not listed; deleting the chosen route reads the line again", async () => {
    const extra = (await caller.control.create({ codes: "43", xpos: 46, ypos: 14 })).id;
    await caller.legRoute.save({ fromControlId: south, toControlId: extra, points: [{ x: 40, y: 12 }] });
    expect(await caller.legRoute.list()).toHaveLength(2);
    await caller.control.delete({ id: extra });
    expect((await caller.legRoute.list()).map((r) => r.id)).toEqual([routeId]);
    await caller.legRoute.choose({ id: routeId, chosen: false });
    const line = await climbOf(over);
    await caller.legRoute.choose({ id: routeId, chosen: true });
    expect((await climbOf(over)).m).toBeLessThan(line.m);
    await caller.legRoute.delete({ id: routeId });
    expect(await climbOf(over)).toEqual(line);
  });

  it("the routes are in the event's backup", () => {
    expect(BACKUP_TABLES).toContain("leg_routes");
    expect(BACKUP_TABLES.indexOf("leg_routes")).toBeGreaterThan(BACKUP_TABLES.indexOf("controls"));
  });

  it("the checkout snapshot carries the routes verbatim", async () => {
    await caller.legRoute.save({ fromControlId: south, toControlId: north, points: AROUND });
    await caller.legRoute.save({ fromControlId: north, toControlId: south, points: AROUND, chosen: false });
    const before = await ctx.db.legRoute.findMany({ where: { eventId: ctx.eventId }, orderBy: { id: "asc" } });
    expect(before.length).toBeGreaterThanOrEqual(2);
    const snapshot = await exportEventSnapshot(ctx.db, ctx.event);
    expect(snapshot.tables.legRoute).toHaveLength(before.length);
    snapshot.event = { ...snapshot.event, nameId: `${ctx.event.nameId}_copy` };
    // The ids travel verbatim, so the copy can only exist once the original is gone.
    await ctx.db.legRoute.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.course.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.control.deleteMany({ where: { eventId: ctx.eventId } });
    const local = await importEventSnapshot(ctx.db, snapshot);
    try {
      const after = await ctx.db.legRoute.findMany({ where: { eventId: local.id }, orderBy: { id: "asc" } });
      expect(after.map(({ eventId: _e, ...r }) => r)).toEqual(before.map(({ eventId: _e, ...r }) => r));
    } finally {
      await ctx.db.event.delete({ where: { id: local.id } });
    }
  });
});
