/**
 * Automatic leg routes and the winner pace (docs/course-elevation.md
 * §7.5, §7.8): every pair an ordered course runs gets the shortest legal
 * route, searched after the edit has committed; the row is chosen unless
 * a person chose otherwise, and a refresh never changes the choice; a
 * pair whose basis is current is not searched again.
 *
 * Fixture: the hill of `course-climb.test.ts` with a lake (301) across
 * the straight way between two controls east and west of it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "crypto";
import { mapDocument } from "@oxygen/shared";
import { S, rect } from "@oxygen/shared/src/terrain/graph/__tests__/synthetic.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { HILL, encodeTerrainDoc } from "../helpers/terrain-doc.js";
import { deriveDocumentHeightfield } from "../../map-store/heightfield.js";
import { resetClimbFields } from "../../course-climb.js";
import { _autoRouteWorkerStarts, autoRouteBasis, drainAutoRoutes, refreshAutoRoutes, type AutoRouteWorkerData } from "../../leg-routes-auto.js";
import { acquireLease, releaseLease } from "../../sync/lease.js";
import { searchAutoRoutes } from "../../leg-routes-auto-worker.js";

const suffix = randomBytes(4).toString("hex");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** A lake 2 mm wide from y 22 to y 38: the leg west → east at y 30 runs into it. */
const LAKE = rect(29, 22, 31, 38);

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let west: number;
let east: number;
let cross: number;
let bytes: Uint8Array;

const routes = async () => {
  await drainAutoRoutes();
  return caller.legRoute.list();
};
const pair = async (from: number, to: number) => (await routes()).filter((r) => r.fromControlId === from && r.toControlId === to);
const lengthOf = (points: { x: number; y: number }[], a: { x: number; y: number }, b: { x: number; y: number }) =>
  [a, ...points, b].slice(1).reduce((mm, p, i, all) => mm + Math.hypot(p.x - (i === 0 ? a : all[i - 1]).x, p.y - (i === 0 ? a : all[i - 1]).y), 0);

beforeAll(async () => {
  // Off for the other integration files (`helpers/load-env.ts`).
  process.env.AUTO_LEG_ROUTES = "on";
  resetClimbFields();
  ctx = await createTestEvent("leg_routes_auto");
  caller = makeCaller(ctx.event);
  const sourceBytes = Buffer.from(`leg-routes-auto-source-${suffix}`);
  const sourceHash = sha(sourceBytes);
  await ctx.db.mapSource.create({ data: { fileHash: sourceHash, kind: "ocad", bytes: sourceBytes, sizeBytes: sourceBytes.byteLength, fileName: "synthetic.ocd" } });
  bytes = encodeTerrainDoc([...HILL, { sym: S.water, coords: LAKE }], `auto-${suffix}`, sourceHash);
  const hash = sha(bytes);
  const { header } = mapDocument.readMapDocumentHeader(bytes);
  await ctx.db.mapDocument.create({
    data: {
      hash, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "test", libraryVersion: "none", sourceHash,
      header: JSON.parse(JSON.stringify({ ...header, symbols: undefined, strings: undefined })), report: {},
    },
  });
  await ctx.db.mapFile.create({ data: { eventId: ctx.eventId, fileName: "synthetic.ocd", sourceHash, documentHash: hash, scale: 15000 } });
  await deriveDocumentHeightfield(ctx.db, hash);
  await caller.control.create({ status: 4, xpos: 12, ypos: 12 });
  await caller.control.create({ status: 5, xpos: 48, ypos: 48 });
  west = (await caller.control.create({ codes: "51", xpos: 14, ypos: 30 })).id;
  east = (await caller.control.create({ codes: "52", xpos: 46, ypos: 30 })).id;
  cross = (await caller.course.create({ name: "Across", controlIds: [west, east] })).id;
});

afterAll(async () => {
  await drainAutoRoutes();
  process.env.AUTO_LEG_ROUTES = "off";
  await ctx.cleanup();
  await disconnect();
});

describe("automatic leg routes (docs/course-elevation.md §7.5)", () => {
  it("the search itself: the line where it is legal, round the lake where it is not", () => {
    const [line, round] = searchAutoRoutes({
      bytes, patch: null, groundMPerMm: 15,
      jobs: [{ from: { x: 14, y: 44 }, to: { x: 46, y: 44 }, obstacles: [] }, { from: { x: 14, y: 30 }, to: { x: 46, y: 30 }, obstacles: [] }],
    });
    expect(line).toEqual({ ok: true, points: [] });
    expect(round.ok && round.points!.length).toBeGreaterThan(0);
  });

  it("a course's pairs get their automatic route once the edit has committed: chosen, the shortest way round", async () => {
    const all = await routes();
    // Start → 51, 51 → 52, 52 → finish.
    expect(all).toHaveLength(3);
    for (const r of all) expect(r).toMatchObject({ auto: true, chosen: true, source: "computed", model: "shortest" });
    const [r] = await pair(west, east);
    expect(r.points.length).toBeGreaterThan(0);
    const mm = lengthOf(r.points, { x: 14, y: 30 }, { x: 46, y: 30 });
    expect(mm).toBeGreaterThan(32);
    // The shorter way is south of the lake (8 mm down) or north of it (8 mm up): about 2 × hypot(15, 8) + 2.
    expect(mm).toBeLessThan(38);
    // A pair whose line is legal has the line: an automatic row without points.
    expect(all.filter((x) => x.points.length === 0)).toHaveLength(2);
    // The stored climb is the course's, computed along the routes.
    const row = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: cross } });
    expect(row.climbSource).toBe("computed");
  });

  it("nothing is searched again while the basis holds; the basis names what the route rests on", async () => {
    await drainAutoRoutes();
    expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBe(0);
    const base = { documentHash: "d", patchVersion: "0", scale: 15000, from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, obstacles: [] };
    expect(autoRouteBasis(base)).toBe(autoRouteBasis({ ...base }));
    for (const other of [{ documentHash: "e" }, { patchVersion: "1" }, { scale: 10000 }, { from: { x: 1, y: 2.5 } }, { via: { x: 2, y: 2 } }, { obstacles: [{ kind: "line" as const, coords: [0, 0, 1, 1] }] }])
      expect(autoRouteBasis({ ...base, ...other })).not.toBe(autoRouteBasis(base));
  });

  it("a moved control: the pair is searched again, the row and its choice stay", async () => {
    const [before] = await pair(west, east);
    await caller.control.update({ id: west, xpos: 14, ypos: 28 });
    const [after] = await pair(west, east);
    expect(after.id).toBe(before.id);
    expect(after.chosen).toBe(true);
    expect(after.points).not.toEqual(before.points);
    await caller.control.update({ id: west, xpos: 14, ypos: 30 });
  });

  it("the automatic route is not edited or deleted by hand", async () => {
    const [auto] = await pair(west, east);
    await expect(caller.legRoute.save({ id: auto.id, fromControlId: west, toControlId: east, points: [{ x: 30, y: 40 }] })).rejects.toThrow(/automatic/);
    await expect(caller.legRoute.delete({ id: auto.id })).rejects.toThrow(/automatic/);
  });

  it("a person's choice stays: the drawn line chosen, or another route, over a refresh", async () => {
    const [auto] = await pair(west, east);
    await caller.legRoute.choose({ id: auto.id, chosen: false });
    await caller.control.update({ id: east, xpos: 46, ypos: 29 });
    let [now] = await pair(west, east);
    expect(now).toMatchObject({ id: auto.id, chosen: false, auto: true });
    const drawn = await caller.legRoute.save({ fromControlId: west, toControlId: east, points: [{ x: 30, y: 42 }] });
    await caller.control.update({ id: east, xpos: 46, ypos: 30 });
    const both = await pair(west, east);
    expect(both.find((r) => r.id === drawn.id)).toMatchObject({ chosen: true, auto: false });
    [now] = both.filter((r) => r.auto);
    expect(now.chosen).toBe(false);
    // Chosen back by hand, like any route.
    await caller.legRoute.choose({ id: auto.id, chosen: true });
    expect((await pair(west, east)).find((r) => r.auto)!.chosen).toBe(true);
    await caller.legRoute.delete({ id: drawn.id });
  });

  it("an out-of-bounds area of the course layer closes a side", async () => {
    const [before] = await pair(west, east);
    const south = Math.min(...before.points.map((p) => p.y)) < 22;
    // The side the route took is closed: it goes round the other end of the lake.
    const geometry = south ? [{ x: 28, y: 10 }, { x: 32, y: 10 }, { x: 32, y: 23 }, { x: 28, y: 23 }] : [{ x: 28, y: 37 }, { x: 32, y: 37 }, { x: 32, y: 50 }, { x: 28, y: 50 }];
    const o = await caller.courseObject.create({ kind: "oob_area", geometry, props: {}, scope: { all: true } });
    const [after] = await pair(west, east);
    expect(after.id).toBe(before.id);
    if (south) expect(Math.max(...after.points.map((p) => p.y))).toBeGreaterThan(38);
    else expect(Math.min(...after.points.map((p) => p.y))).toBeLessThan(22);
    await caller.courseObject.delete({ id: o.id });
    expect((await pair(west, east))[0].points).toEqual(before.points);
  });

  it("a marked-route leg is not searched; a free-order course gets none", async () => {
    const a = (await caller.control.create({ codes: "53", xpos: 20, ypos: 44 })).id;
    const b = (await caller.control.create({ codes: "54", xpos: 40, ypos: 44 })).id;
    const marked = (await caller.course.create({ name: "Marked", controlIds: [a, b] })).id;
    expect(await pair(a, b)).toHaveLength(1);
    const basis = async () => (await ctx.db.legRoute.findFirstOrThrow({ where: { eventId: ctx.eventId, id: (await pair(a, b))[0].id } })).autoBasis;
    const first = await basis();
    const detail = await caller.course.detail({ id: marked });
    const structure = detail.structure as { items: { siteId: number; leg?: Record<string, unknown> }[] };
    const items = structure.items.map((i) => (i.siteId === b ? { ...i, leg: { ...(i.leg ?? {}), style: "marked_route" } } : i));
    await caller.course.setStructure({ courseId: marked, structure: { ...structure, items } as never });
    // The marked leg's pair is no longer searched: a moved control leaves its row as it was.
    await caller.control.update({ id: b, xpos: 40, ypos: 42 });
    expect(await basis()).toBe(first);
    await caller.course.setStructure({ courseId: marked, structure: structure as never });
    expect(await basis()).not.toBe(first);
    const free = await caller.course.create({ name: "Free", controlIds: [b, a], orderMode: "free_order" });
    expect(free.id).toBeGreaterThan(0);
    expect(await pair(b, a)).toEqual([]);
  });

  it("an object drawn with named courses closes the way only while every course running the pair is named (§0.25)", async () => {
    const [before] = await pair(west, east);
    const south = Math.min(...before.points.map((p) => p.y)) < 22;
    const geometry = south ? [{ x: 28, y: 10 }, { x: 32, y: 10 }, { x: 32, y: 23 }, { x: 28, y: 23 }] : [{ x: 28, y: 37 }, { x: 32, y: 37 }, { x: 32, y: 50 }, { x: 28, y: 50 }];
    const o = await caller.courseObject.create({ kind: "oob_area", geometry, props: {}, scope: { courses: [cross], classes: [] } });
    expect((await pair(west, east))[0].points).not.toEqual(before.points);
    // Another course runs the pair without the object: the way is open again.
    const also = (await caller.course.create({ name: "Also across", controlIds: [west, east] })).id;
    expect((await pair(west, east))[0].points).toEqual(before.points);
    await caller.course.delete({ id: also });
    await caller.courseObject.delete({ id: o.id });
    expect((await pair(west, east))[0].points).toEqual(before.points);
  });

  it("a leg with a crossing point is routed through it", async () => {
    const c = (await caller.control.create({ codes: "55", xpos: 20, ypos: 16 })).id;
    const d = (await caller.control.create({ codes: "56", xpos: 40, ypos: 16 })).id;
    const via = (await caller.control.create({ kind: "crossing_point", xpos: 30, ypos: 8 })).id;
    const id = (await caller.course.create({ name: "Through", controlIds: [c, d] })).id;
    expect((await pair(c, d))[0].points).toEqual([]);
    const detail = await caller.course.detail({ id });
    const structure = detail.structure as { items: { siteId: number; leg?: Record<string, unknown> }[] };
    const items = structure.items.map((i) => (i.siteId === d ? { ...i, leg: { ...(i.leg ?? {}), crossing: { controlId: via } } } : i));
    await caller.course.setStructure({ courseId: id, structure: { ...structure, items } as never });
    const [r] = await pair(c, d);
    expect(r.points.some((p) => Math.hypot(p.x - 30, p.y - 8) < 0.5)).toBe(true);
  });

  it("two edits in a row: the refresh asked for while one runs is run once more, and the routes end current", async () => {
    await drainAutoRoutes();
    void caller.control.update({ id: west, xpos: 14, ypos: 27 });
    await caller.control.update({ id: west, xpos: 14, ypos: 30 });
    await drainAutoRoutes();
    expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBe(0);
  });

  /** The pairs of a course made stale and its stored route made wrong, as a changed map would leave them. */
  const stale = async (from: number, to: number) => {
    const fromUuid = (await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: String(from) } })).id;
    const toUuid = (await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: String(to) } })).id;
    await ctx.db.legRoute.updateMany({ where: { eventId: ctx.eventId, fromControlId: fromUuid, toControlId: toUuid, autoBasis: { not: null } }, data: { autoBasis: "stale", points: [{ x: 1, y: 1 }] } });
    return { fromUuid, toUuid };
  };
  const basisOf = async (fromUuid: string, toUuid: string) => (await ctx.db.legRoute.findFirstOrThrow({ where: { eventId: ctx.eventId, fromControlId: fromUuid, toControlId: toUuid, autoBasis: { not: null } } })).autoBasis;
  const withEnqueueOff = async (run: () => Promise<void>) => {
    process.env.AUTO_LEG_ROUTES = "off";
    try { await run(); } finally { process.env.AUTO_LEG_ROUTES = "on"; }
  };

  it("one pair that fails does not block its chunk: the others are written and their climbs computed; the failed pair is not searched again until its basis changes", async () => {
    await drainAutoRoutes();
    await withEnqueueOff(async () => {
      // Start → 51 and 51 → 52 are stale; the edit itself computed the climb along the old vertices.
      await caller.control.update({ id: west, xpos: 14, ypos: 27 });
      const [before] = await pair(west, east);
      const fromStart = (d: AutoRouteWorkerData, i: number) => d.jobs[i].from.x === 12 && d.jobs[i].from.y === 12;
      const seen: number[] = [];
      const search = async (data: AutoRouteWorkerData) => {
        seen.push(data.jobs.length);
        return searchAutoRoutes(data).map((r, i) => (fromStart(data, i) ? { ok: false as const, error: "no luck" } : r));
      };
      const startBasis = async () => (await ctx.db.legRoute.findMany({ where: { eventId: ctx.eventId, autoBasis: { not: null } } })).map((r) => r.autoBasis).sort().join();
      const rowsBefore = await startBasis();
      await expect(refreshAutoRoutes(ctx.db, ctx.eventId, { chunk: 3, search })).rejects.toThrow(/no luck/);
      expect(seen).toEqual([2]);
      const [after] = await pair(west, east);
      expect(after.points).not.toEqual(before.points);
      expect((await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: cross } })).climbSource).toBe("computed");
      // The failed pair keeps its old row; its basis is remembered, so it is not handed to the search again.
      expect(await startBasis()).not.toBe(rowsBefore);
      const calls: number[] = [];
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId, { search: async (d) => { calls.push(d.jobs.length); return searchAutoRoutes(d); } })).toBe(0);
      expect(calls).toEqual([]);
      // A control of it moves: the basis changes and the pair is searched again.
      await caller.control.update({ id: west, xpos: 14, ypos: 26 });
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId, { search: async (d) => { calls.push(d.jobs.length); return searchAutoRoutes(d); } })).toBe(2);
      expect(calls).toEqual([2]);
      await caller.control.update({ id: west, xpos: 14, ypos: 30 });
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBe(2);
    });
  });

  it("a search that cannot run fails its chunk only: the other chunks are written, and the pair is tried again", async () => {
    await drainAutoRoutes();
    await withEnqueueOff(async () => {
      await caller.control.update({ id: west, xpos: 14, ypos: 27 });
      let calls = 0;
      const search = async (data: AutoRouteWorkerData) => {
        if (++calls === 1) throw new Error("search gave up");
        return searchAutoRoutes(data);
      };
      await expect(refreshAutoRoutes(ctx.db, ctx.eventId, { chunk: 1, search })).rejects.toThrow(/gave up/);
      expect(calls).toBe(2);
      // The pair whose chunk was lost is the one left: nothing was remembered of it.
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBe(1);
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBe(0);
      await caller.control.update({ id: west, xpos: 14, ypos: 30 });
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBe(2);
    });
  });

  it("one worker serves a whole refresh: two chunks, one start, the right routes", async () => {
    await drainAutoRoutes();
    await withEnqueueOff(async () => {
      await caller.control.update({ id: west, xpos: 14, ypos: 28 });
      const starts = _autoRouteWorkerStarts();
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId, { chunk: 1 })).toBe(2);
      expect(_autoRouteWorkerStarts() - starts).toBe(1);
      const [r] = await pair(west, east);
      expect(lengthOf(r.points, { x: 14, y: 28 }, { x: 46, y: 30 })).toBeGreaterThan(32);
      await caller.control.update({ id: west, xpos: 14, ypos: 30 });
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBe(2);
    });
  });

  it("a course that gains the pair while it is searched has its climb read along the new route too", async () => {
    await drainAutoRoutes();
    await withEnqueueOff(async () => {
      await stale(51, 52);
      let late = 0;
      const search = async (data: AutoRouteWorkerData) => {
        // Created after the pairs were read: no snapshot of them names it.
        late = (await caller.course.create({ name: "Late", controlIds: [west, east] })).id;
        await ctx.db.course.updateMany({ where: { eventId: ctx.eventId, seq: late }, data: { climbM: 777, climbSource: "computed" } });
        return searchAutoRoutes(data);
      };
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId, { search })).toBe(1);
      const row = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: late } });
      expect(row.climbM).not.toBe(777);
      expect(row.climbSource).toBe("computed");
      await caller.course.delete({ id: late });
    });
  });

  it("the climbs a chunk cleared are computed before the next chunk is searched", async () => {
    await drainAutoRoutes();
    await withEnqueueOff(async () => {
      // 51 → 52 of the first course and 53 → 54 of the second: their routes are wrong, their climbs a stale 777.
      await stale(51, 52);
      await stale(53, 54);
      await ctx.db.course.updateMany({ where: { eventId: ctx.eventId, name: { in: ["Across", "Marked"] } }, data: { climbM: 777, climbSource: "computed" } });
      const seenAtSecond: { m: number; source: string | null }[] = [];
      let calls = 0;
      const search = async (data: AutoRouteWorkerData) => {
        if (++calls === 2) {
          const c = await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, name: "Across" } });
          seenAtSecond.push({ m: c.climbM, source: c.climbSource });
        }
        return searchAutoRoutes(data);
      };
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId, { chunk: 1, search })).toBe(2);
      expect(calls).toBe(2);
      expect(seenAtSecond[0].source).toBe("computed");
      expect(seenAtSecond[0].m).not.toBe(777);
    });
  });

  it("a route a person saves while the search runs stays the chosen one", async () => {
    process.env.AUTO_LEG_ROUTES = "off";
    try {
      const e = (await caller.control.create({ codes: "57", xpos: 20, ypos: 46 })).id;
      const f = (await caller.control.create({ codes: "58", xpos: 40, ypos: 46 })).id;
      await caller.course.create({ name: "Meanwhile", controlIds: [e, f] });
      let drawn = 0;
      const search = async (data: Parameters<typeof searchAutoRoutes>[0]) => {
        if (!drawn) drawn = (await caller.legRoute.save({ fromControlId: e, toControlId: f, points: [{ x: 30, y: 47 }] })).id;
        return searchAutoRoutes(data);
      };
      await refreshAutoRoutes(ctx.db, ctx.eventId, { search });
      const both = (await caller.legRoute.list()).filter((r) => r.fromControlId === e && r.toControlId === f);
      expect(both.find((r) => r.id === drawn)).toMatchObject({ chosen: true, auto: false });
      expect(both.find((r) => r.auto)).toMatchObject({ chosen: false });
    } finally {
      process.env.AUTO_LEG_ROUTES = "on";
    }
  });
});

describe("during a lease (docs/course-elevation.md §7.5, D8)", () => {
  const moveWest = (ypos: number) => ctx.db.control.updateMany({ where: { eventId: ctx.eventId, codes: "51" }, data: { ypos } });
  const journal = () => ctx.db.journalEntry.count({ where: { eventId: ctx.eventId, type: "course.upserted" } });
  const snapshot = async () => JSON.stringify((await ctx.db.legRoute.findMany({ where: { eventId: ctx.eventId }, orderBy: { id: "asc" } })).map((r) => [r.id, r.autoBasis, r.points, r.chosen]));
  const neverSearch = async (): Promise<never> => { throw new Error("a node that does not hold the lease must not search"); };

  it("a node that does not hold the event's lease searches nothing and writes nothing; the holder does after it ends", async () => {
    await drainAutoRoutes();
    process.env.AUTO_LEG_ROUTES = "off";
    try {
      await moveWest(27);
      const rows = await snapshot();
      const entries = await journal();
      await acquireLease(ctx.db, ctx.eventId, "venue-d8");
      try {
        expect(await refreshAutoRoutes(ctx.db, ctx.eventId, { search: neverSearch })).toBe(0);
        expect(await snapshot()).toBe(rows);
        expect(await journal()).toBe(entries);
      } finally {
        await releaseLease(ctx.db, ctx.eventId);
      }
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBeGreaterThan(0);
      await moveWest(30);
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBeGreaterThan(0);
    } finally {
      process.env.AUTO_LEG_ROUTES = "on";
    }
  });

  it("a lease taken while a chunk is searched: its rows are not written and nothing is cleared", async () => {
    await drainAutoRoutes();
    process.env.AUTO_LEG_ROUTES = "off";
    try {
      await moveWest(27);
      const rows = await snapshot();
      const climb = (await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: cross } })).climbM;
      let calls = 0;
      try {
        const search = async (data: AutoRouteWorkerData) => {
          if (++calls === 1) await acquireLease(ctx.db, ctx.eventId, "venue-d8");
          return searchAutoRoutes(data);
        };
        expect(await refreshAutoRoutes(ctx.db, ctx.eventId, { chunk: 1, search })).toBe(0);
        expect(calls).toBe(1);
        expect(await snapshot()).toBe(rows);
        expect((await ctx.db.course.findFirstOrThrow({ where: { eventId: ctx.eventId, seq: cross } })).climbM).toBe(climb);
      } finally {
        await releaseLease(ctx.db, ctx.eventId);
      }
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBeGreaterThan(0);
      await moveWest(30);
      expect(await refreshAutoRoutes(ctx.db, ctx.eventId)).toBeGreaterThan(0);
    } finally {
      process.env.AUTO_LEG_ROUTES = "on";
    }
  });
});

describe("the winner pace (docs/course-elevation.md §7.8)", () => {
  it("is the course's: stored, listed, cleared; 2:00 to 30:00", async () => {
    expect((await caller.course.detail({ id: cross })).winnerPaceSPerKm).toBeNull();
    await caller.course.update({ id: cross, winnerPaceSPerKm: 345 });
    expect((await caller.course.detail({ id: cross })).winnerPaceSPerKm).toBe(345);
    expect((await caller.course.list()).find((c) => c.id === cross)!.winnerPaceSPerKm).toBe(345);
    await expect(caller.course.update({ id: cross, winnerPaceSPerKm: 90 })).rejects.toThrow();
    await expect(caller.course.update({ id: cross, winnerPaceSPerKm: 2000 })).rejects.toThrow();
    await caller.course.update({ id: cross, winnerPaceSPerKm: null });
    expect((await caller.course.detail({ id: cross })).winnerPaceSPerKm).toBeNull();
  });
});
