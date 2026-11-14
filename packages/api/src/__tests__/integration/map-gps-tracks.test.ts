/**
 * GPS tracks per event (docs/map-gps-tracks.md §1; row G24).
 *
 *   - the table: CHECKs, cascade with the event, created_by SET NULL
 *   - mapTrack.import / list / get: round trip (points deep-equal, null
 *     columns, an average with derivedFrom + singlePass), list without
 *     points, input order, a retried import by id is a no-op, an id of
 *     another event is refused, another event cannot read
 *   - caps: 200 000 points a track, 200 tracks an event (nothing written),
 *     500 000 points a call
 *   - update (name, trim, unchanged keeps the version), split (shares its
 *     point, carries trims, divides single_pass, replaces the row, a
 *     repeat with ids), split-split-remove, split at the event cap
 *   - remove, markConverted
 *   - auth: a course setter does everything; a viewer, a kiosk key and a
 *     stranger can neither read nor write
 *   - not journaled, not in the checkout snapshot
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "crypto";
import { SYSTEM_GROUP_IDS, gpsTrack } from "@oxygen/shared";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { grantSystemGroup } from "../../permissions.js";
import { exportEventSnapshot } from "../../sync/lease.js";
import { MAX_EVENT_TRACKS, MAX_TRACK_POINTS } from "../../gps-tracks.js";
import type { AuthUser } from "../../auth.js";

const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-gps-tracks-${suffix}.example`;
const KIOSK = `kiosk-${suffix}`;
const T0 = Date.UTC(2026, 0, 10, 9, 0, 0);

let ctx: TestEventContext;
let other: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let setter: AuthUser;
let viewer: AuthUser;
let stranger: AuthUser;
let previousAuthMode: string | undefined;
let journalBefore: number;

/** A synthetic track: a line north-east from a point in Sweden, a fix a second. */
function synthetic(n: number, opts: { timed?: boolean; ele?: boolean; offset?: number } = {}): gpsTrack.TrackPoints {
  const { timed = true, ele = true, offset = 0 } = opts;
  return {
    lat: Array.from({ length: n }, (_, i) => 596_000_000 + offset + i * 90),
    lng: Array.from({ length: n }, (_, i) => 180_000_000 + offset + i * 70),
    time: timed ? Array.from({ length: n }, (_, i) => T0 + i * 1000) : null,
    ele: ele ? Array.from({ length: n }, (_, i) => gpsTrack.quantiseEle(20 + i * 0.3)) : null,
  };
}

const item = (n: number, name: string | null = "Loop", extra: Record<string, unknown> = {}) => ({ name, sourceName: "loop.gpx", points: synthetic(n), ...extra });

async function reset(): Promise<void> {
  await ctx.db.mapGpsTrack.deleteMany({ where: { eventId: ctx.eventId } });
}

async function mkUser(name: string): Promise<AuthUser> {
  return ctx.db.user.create({ data: { email: `${name}${EMAIL_DOMAIN}`, displayName: name, isAdmin: false, active: true } });
}

beforeAll(async () => {
  ctx = await createTestEvent("map_gps_tracks");
  other = await createTestEvent("map_gps_tracks_other");
  caller = makeCaller(ctx.event);
  setter = await mkUser("setter");
  viewer = await mkUser("viewer");
  stranger = await mkUser("stranger");
  await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: setter.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: setter.id });
  const group = await ctx.db.permissionGroup.create({ data: { name: `Track viewer ${suffix}`, capabilities: ["event.view", "courses.view"] } });
  await ctx.db.eventPermission.create({ data: { eventId: ctx.eventId, userId: viewer.id, groupId: group.id } });
  // A future date: a completed event grants courses.view to every signed-in user.
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { kioskKey: KIOSK, date: new Date("2099-06-01T00:00:00Z") } });
  ctx.event.kioskKey = KIOSK;
  ctx.event.date = new Date("2099-06-01T00:00:00Z");
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "proxy";
  journalBefore = await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId } });
}, 60_000);

afterAll(async () => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  await ctx?.cleanup();
  await other?.cleanup();
  await ctx.db.permissionGroup.deleteMany({ where: { name: `Track viewer ${suffix}` } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

describe("the table", () => {
  it("refuses a bad trim, a non-object points and a non-array single_pass", async () => {
    const base = { eventId: ctx.eventId, points: synthetic(4), pointCount: 4, trimEnd: 4 };
    await expect(ctx.db.mapGpsTrack.create({ data: { ...base, trimStart: 3 } })).rejects.toThrow(/map_gps_tracks_trim_check/);
    await expect(ctx.db.mapGpsTrack.create({ data: { ...base, trimEnd: 5 } })).rejects.toThrow(/map_gps_tracks_trim_check/);
    await expect(ctx.db.mapGpsTrack.create({ data: { ...base, points: [1, 2] } })).rejects.toThrow(/map_gps_tracks_points_check/);
    await expect(ctx.db.mapGpsTrack.create({ data: { ...base, singlePass: { start: 0 } } })).rejects.toThrow(/map_gps_tracks_single_pass_check/);
  });

  it("deletes an event's tracks with the event", async () => {
    const doomed = await createTestEvent("map_gps_tracks_doomed");
    const [t] = (await makeCaller(doomed.event).mapTrack.import({ tracks: [item(3)] })).tracks;
    await doomed.cleanup();
    expect(await ctx.db.mapGpsTrack.findUnique({ where: { id: t.id } })).toBeNull();
  });

  it("keeps a track when its importer is deleted (created_by SET NULL)", async () => {
    await reset();
    const gone = await mkUser("gone");
    await grantSystemGroup(ctx.db, { eventId: ctx.eventId, userId: gone.id, groupId: SYSTEM_GROUP_IDS.courseSetter, grantedBy: setter.id });
    const as = makeCaller(ctx.event, { user: gone, authEnabled: true, authMode: "proxy", identityEmail: gone.email });
    const [t] = (await as.mapTrack.import({ tracks: [item(3)] })).tracks;
    expect(t.createdBy).toBe(gone.id);
    await ctx.db.eventPermission.deleteMany({ where: { userId: gone.id } });
    await ctx.db.user.delete({ where: { id: gone.id } });
    expect((await caller.mapTrack.get({ id: t.id })).createdBy).toBeNull();
  });
});

describe("mapTrack.import / list / get", () => {
  it("round-trips the points exactly, with null columns, in input order", async () => {
    await reset();
    const untimed = { name: null, sourceName: "route.gpx", points: synthetic(5, { timed: false, ele: false }) };
    const { tracks } = await caller.mapTrack.import({ tracks: [item(6, "First"), untimed, item(4, "Third")] });
    expect(tracks.map((t) => t.name)).toEqual(["First", null, "Third"]);
    expect(tracks[0]).toMatchObject({ sourceName: "loop.gpx", pointCount: 6, recordedAt: T0, trim: { start: 0, end: 6 }, derivedFrom: [], singlePass: null, convertedOp: null, createdBy: null });
    expect(tracks[1]).toMatchObject({ recordedAt: null, pointCount: 5 });
    expect(BigInt(tracks[0].version)).toBeGreaterThan(2n ** 53n);

    const got = await caller.mapTrack.get({ id: tracks[0].id });
    expect(got.points).toEqual(synthetic(6));
    expect((await caller.mapTrack.get({ id: tracks[1].id })).points).toEqual(untimed.points);

    const { tracks: listed } = await caller.mapTrack.list();
    expect(listed.map((t) => t.id)).toEqual(tracks.map((t) => t.id));
    expect(listed[0]).toEqual(tracks[0]);
    expect(listed[0]).not.toHaveProperty("points");
  });

  it("stores a column of only nulls as null", async () => {
    await reset();
    const points = { ...synthetic(3), time: [null, null, null] };
    const [t] = (await caller.mapTrack.import({ tracks: [{ name: "x", sourceName: "x.gpx", points }] })).tracks;
    expect((await caller.mapTrack.get({ id: t.id })).points.time).toBeNull();
  });

  it("stores an average with its passes and single-pass ranges", async () => {
    await reset();
    const passes = (await caller.mapTrack.import({ tracks: [item(5, "a"), item(5, "b")] })).tracks.map((t) => t.id);
    const singlePass = [{ start: 0, end: 2 }, { start: 5, end: 8 }];
    const [avg] = (await caller.mapTrack.import({
      tracks: [{ name: "Average", sourceName: "", points: synthetic(8, { timed: false, ele: false }), derivedFrom: passes, singlePass }],
    })).tracks;
    expect(avg).toMatchObject({ derivedFrom: passes, singlePass, sourceName: "" });
    expect(await caller.mapTrack.get({ id: avg.id })).toMatchObject({ derivedFrom: passes, singlePass });
  });

  it("refuses derivedFrom without singlePass, and bad ranges, writing nothing", async () => {
    await reset();
    const passes = [randomUUID(), randomUUID()];
    await expect(caller.mapTrack.import({ tracks: [item(4, "a", { derivedFrom: passes })] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^TRACK_POINTS_INVALID/) });
    await expect(caller.mapTrack.import({ tracks: [item(4), item(4, "a", { derivedFrom: passes, singlePass: [{ start: 3, end: 5 }] })] })).rejects.toMatchObject({ message: expect.stringMatching(/^TRACK_POINTS_INVALID/) });
    await expect(caller.mapTrack.import({ tracks: [item(4), { name: "bad", sourceName: "", points: { ...synthetic(4), ele: [1.25, 1, 1, 1] } }] })).rejects.toMatchObject({ message: expect.stringMatching(/^TRACK_POINTS_INVALID.*track 1/) });
    expect(await ctx.db.mapGpsTrack.count({ where: { eventId: ctx.eventId } })).toBe(0);
  });

  it("refuses derivedFrom naming a pass twice and an id twice in one call, writing nothing", async () => {
    await reset();
    const pass = randomUUID();
    await expect(caller.mapTrack.import({ tracks: [item(4, "avg", { derivedFrom: [pass, pass], singlePass: [] })] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^TRACK_POINTS_INVALID.*twice/) });
    const id = randomUUID();
    await expect(caller.mapTrack.import({ tracks: [item(4, "a", { id }), item(4, "b", { id })] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^TRACK_POINTS_INVALID.*twice/) });
    expect(await ctx.db.mapGpsTrack.count({ where: { eventId: ctx.eventId } })).toBe(0);
  });

  it("keeps file order with client-minted ids minted ascending", async () => {
    await reset();
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort();
    await caller.mapTrack.import({ tracks: ids.map((id, i) => item(3, `t${i}`, { id })) });
    expect((await caller.mapTrack.list()).tracks.map((t) => t.name)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("answers a retried import by id as stored, and refuses an id of another event", async () => {
    await reset();
    const id = randomUUID();
    const [first] = (await caller.mapTrack.import({ tracks: [item(4, "Once", { id })] })).tracks;
    expect(first.id).toBe(id);
    const [again] = (await caller.mapTrack.import({ tracks: [item(9, "Twice", { id })] })).tracks;
    expect(again).toEqual(first);
    expect(await ctx.db.mapGpsTrack.count({ where: { eventId: ctx.eventId } })).toBe(1);
    await expect(makeCaller(other.event).mapTrack.import({ tracks: [item(4, "x", { id })] })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/^TRACK_ID_TAKEN/) });
  });

  it("scopes every read and write to the event", async () => {
    await reset();
    const [t] = (await caller.mapTrack.import({ tracks: [item(4)] })).tracks;
    const elsewhere = makeCaller(other.event);
    expect((await elsewhere.mapTrack.list()).tracks).toEqual([]);
    await expect(elsewhere.mapTrack.get({ id: t.id })).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringMatching(/^TRACK_NOT_FOUND/) });
    await expect(elsewhere.mapTrack.update({ id: t.id, name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(elsewhere.mapTrack.split({ id: t.id, index: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(elsewhere.mapTrack.markConverted({ marks: [{ id: t.id, opId: null }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await elsewhere.mapTrack.remove({ ids: [t.id] })).toEqual({ removed: 0 });
    expect((await caller.mapTrack.get({ id: t.id })).name).toBe("Loop");
  });
});

describe("caps", () => {
  it(`accepts ${MAX_TRACK_POINTS} points a track and refuses one more`, async () => {
    await reset();
    const [big] = (await caller.mapTrack.import({ tracks: [{ name: "big", sourceName: "big.gpx", points: synthetic(MAX_TRACK_POINTS) }] })).tracks;
    expect(big.pointCount).toBe(MAX_TRACK_POINTS);
    expect((await caller.mapTrack.get({ id: big.id })).points.lat).toHaveLength(MAX_TRACK_POINTS);
    await expect(caller.mapTrack.import({ tracks: [{ name: "big", sourceName: "big.gpx", points: synthetic(MAX_TRACK_POINTS + 1) }] })).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: expect.stringMatching(/^TRACK_TOO_MANY_POINTS/),
    });
    expect(await ctx.db.mapGpsTrack.count({ where: { eventId: ctx.eventId } })).toBe(1);
  }, 60_000);

  it("refuses more than 500 000 points in one call", async () => {
    await reset();
    const tracks = [0, 1, 2].map((i) => ({ name: `t${i}`, sourceName: "t.gpx", points: synthetic(170_000, { timed: false, ele: false, offset: i }) }));
    await expect(caller.mapTrack.import({ tracks })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: expect.stringMatching(/^TRACK_REQUEST_TOO_LARGE/) });
    expect(await ctx.db.mapGpsTrack.count({ where: { eventId: ctx.eventId } })).toBe(0);
  }, 30_000);

  it(`holds at most ${MAX_EVENT_TRACKS} tracks an event, refusing the import that passes it whole`, async () => {
    await reset();
    await caller.mapTrack.import({ tracks: Array.from({ length: MAX_EVENT_TRACKS - 1 }, (_, i) => item(2, `t${i}`)) });
    await expect(caller.mapTrack.import({ tracks: [item(2, "a"), item(2, "b")] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/^TRACK_LIMIT/) });
    expect(await ctx.db.mapGpsTrack.count({ where: { eventId: ctx.eventId } })).toBe(MAX_EVENT_TRACKS - 1);
    const [last] = (await caller.mapTrack.import({ tracks: [item(4, "last")] })).tracks;
    // A split adds a row: refused at the cap, the track unchanged.
    await expect(caller.mapTrack.split({ id: last.id, index: 2 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/^TRACK_LIMIT/) });
    expect((await caller.mapTrack.get({ id: last.id })).version).toBe(last.version);
    // Concurrent imports cannot both pass the count (the event lock).
    await caller.mapTrack.remove({ ids: [last.id] });
    const results = await Promise.allSettled([caller.mapTrack.import({ tracks: [item(2, "p")] }), caller.mapTrack.import({ tracks: [item(2, "q")] })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await ctx.db.mapGpsTrack.count({ where: { eventId: ctx.eventId } })).toBe(MAX_EVENT_TRACKS);
  }, 60_000);
});

describe("mapTrack.update", () => {
  it("sets and restores the trim and renames; an unchanged write keeps the version", async () => {
    await reset();
    const [t] = (await caller.mapTrack.import({ tracks: [item(10)] })).tracks;
    const trimmed = await caller.mapTrack.update({ id: t.id, trim: { start: 2, end: 8 } });
    expect(trimmed.trim).toEqual({ start: 2, end: 8 });
    expect(BigInt(trimmed.version)).toBeGreaterThan(BigInt(t.version));
    expect((await caller.mapTrack.get({ id: t.id })).points).toEqual(synthetic(10)); // non-destructive
    expect(await caller.mapTrack.update({ id: t.id, trim: { start: 2, end: 8 } })).toEqual(trimmed);
    const restored = await caller.mapTrack.update({ id: t.id, trim: { start: 0, end: 10 }, name: "Renamed" });
    expect(restored).toMatchObject({ trim: { start: 0, end: 10 }, name: "Renamed" });
    expect((await caller.mapTrack.update({ id: t.id, name: null })).name).toBeNull();
  });

  it.each([[{ start: -1, end: 5 }], [{ start: 0, end: 11 }], [{ start: 4, end: 5 }], [{ start: 6, end: 4 }]])("refuses the trim %j", async (trim) => {
    await reset();
    const [t] = (await caller.mapTrack.import({ tracks: [item(10)] })).tracks;
    await expect(caller.mapTrack.update({ id: t.id, trim })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^TRACK_TRIM_INVALID/) });
  });

  it("does not touch single_pass", async () => {
    await reset();
    const [avg] = (await caller.mapTrack.import({
      tracks: [{ name: "avg", sourceName: "", points: synthetic(10), derivedFrom: [randomUUID(), randomUUID()], singlePass: [{ start: 1, end: 3 }] }],
    })).tracks;
    expect((await caller.mapTrack.update({ id: avg.id, trim: { start: 2, end: 9 } })).singlePass).toEqual([{ start: 1, end: 3 }]);
  });
});

describe("mapTrack.split", () => {
  it("replaces the track with two parts sharing the split point", async () => {
    await reset();
    const [before, t, after] = (await caller.mapTrack.import({ tracks: [item(3, "before"), item(10, "Loop"), item(3, "after")] })).tracks;
    await caller.mapTrack.markConverted({ marks: [{ id: t.id, opId: `add:${randomUUID()}` }] });
    const marked = await caller.mapTrack.get({ id: t.id });
    const { tracks: [left, right] } = await caller.mapTrack.split({ id: t.id, index: 4 });
    const [a, b] = gpsTrack.splitTrack({ name: "Loop", points: synthetic(10) }, 4);
    expect((await caller.mapTrack.get({ id: left.id })).points).toEqual(a.points);
    expect((await caller.mapTrack.get({ id: right.id })).points).toEqual(b.points);
    expect(left).toMatchObject({ name: "Loop", sourceName: "loop.gpx", pointCount: 5, trim: { start: 0, end: 5 }, recordedAt: T0, convertedOp: marked.convertedOp, createdAt: t.createdAt });
    expect(right).toMatchObject({ pointCount: 6, trim: { start: 0, end: 6 }, recordedAt: T0 + 4000, createdAt: t.createdAt });
    await expect(caller.mapTrack.get({ id: t.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The parts stay with their import (ordered there by id).
    const ids = (await caller.mapTrack.list()).tracks.map((x) => x.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids.slice(0, 4))).toEqual(new Set([before.id, left.id, right.id, after.id]));
    expect(ids.indexOf(left.id)).toBeLessThan(ids.indexOf(right.id));
  });

  it("carries both trims and divides single_pass", async () => {
    await reset();
    const [avg] = (await caller.mapTrack.import({
      tracks: [{ name: "avg", sourceName: "", points: synthetic(10, { timed: false }), derivedFrom: [randomUUID(), randomUUID()], singlePass: [{ start: 3, end: 6 }] }],
    })).tracks;
    await caller.mapTrack.update({ id: avg.id, trim: { start: 1, end: 9 } });
    const { tracks: [left, right] } = await caller.mapTrack.split({ id: avg.id, index: 4 });
    expect(left).toMatchObject({ trim: { start: 1, end: 5 }, singlePass: [{ start: 3, end: 5 }], derivedFrom: avg.derivedFrom, recordedAt: null });
    expect(right).toMatchObject({ trim: { start: 0, end: 5 }, singlePass: [{ start: 0, end: 2 }] });
  });

  it("refuses an index without two visible points on each side", async () => {
    await reset();
    const [t] = (await caller.mapTrack.import({ tracks: [item(10)] })).tracks;
    await caller.mapTrack.update({ id: t.id, trim: { start: 2, end: 8 } });
    for (const index of [0, 2, 7, 9]) {
      await expect(caller.mapTrack.split({ id: t.id, index })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^TRACK_SPLIT_INVALID/) });
    }
    expect(await ctx.db.mapGpsTrack.count({ where: { eventId: ctx.eventId } })).toBe(1);
  });

  it("answers a repeat with the same ids as the first answer", async () => {
    await reset();
    const [t] = (await caller.mapTrack.import({ tracks: [item(6)] })).tracks;
    const ids: [string, string] = [randomUUID(), randomUUID()];
    const first = await caller.mapTrack.split({ id: t.id, index: 3, ids });
    expect(first.tracks.map((x) => x.id)).toEqual(ids);
    expect(await caller.mapTrack.split({ id: t.id, index: 3, ids })).toEqual(first);
  });

  it("refuses part ids equal to each other or to the original, and ids already used", async () => {
    await reset();
    const [t, u] = (await caller.mapTrack.import({ tracks: [item(6), item(6)] })).tracks;
    const fresh = randomUUID();
    for (const ids of [[fresh, fresh], [t.id, fresh]] as [string, string][]) {
      await expect(caller.mapTrack.split({ id: t.id, index: 3, ids })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^TRACK_SPLIT_INVALID/) });
    }
    await expect(caller.mapTrack.split({ id: t.id, index: 3, ids: [fresh, u.id] })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/^TRACK_ID_TAKEN/) });
    expect((await caller.mapTrack.get({ id: t.id })).version).toBe(t.version);
  });

  it("cuts out a stretch: split, split, remove the middle", async () => {
    await reset();
    const [t] = (await caller.mapTrack.import({ tracks: [item(12)] })).tracks;
    const [head, rest] = (await caller.mapTrack.split({ id: t.id, index: 3 })).tracks;
    const [middle, tail] = (await caller.mapTrack.split({ id: rest.id, index: 4 })).tracks; // point 7 of the original
    expect(await caller.mapTrack.remove({ ids: [middle.id] })).toEqual({ removed: 1 });
    const left = (await caller.mapTrack.list()).tracks.map((x) => x.id);
    expect(left.sort()).toEqual([head.id, tail.id].sort());
    expect((await caller.mapTrack.get({ id: tail.id })).points.lat).toEqual(synthetic(12).lat.slice(7));
  });
});

describe("mapTrack.remove / markConverted", () => {
  it("removes, and twice is once", async () => {
    await reset();
    const ts = (await caller.mapTrack.import({ tracks: [item(3), item(3)] })).tracks;
    expect(await caller.mapTrack.remove({ ids: [ts[0].id, randomUUID()] })).toEqual({ removed: 1 });
    expect(await caller.mapTrack.remove({ ids: [ts[0].id] })).toEqual({ removed: 0 });
    expect((await caller.mapTrack.list()).tracks.map((t) => t.id)).toEqual([ts[1].id]);
  });

  it("marks, clears, and writes nothing when an id is unknown", async () => {
    await reset();
    const [a, b] = (await caller.mapTrack.import({ tracks: [item(3), item(3)] })).tracks;
    const op = `add:${randomUUID()}`;
    const [ma, mb] = (await caller.mapTrack.markConverted({ marks: [{ id: a.id, opId: op }, { id: b.id, opId: op }] })).tracks;
    expect([ma.convertedOp, mb.convertedOp]).toEqual([op, op]);
    expect((await caller.mapTrack.markConverted({ marks: [{ id: a.id, opId: op }] })).tracks[0].version).toBe(ma.version);
    await expect(caller.mapTrack.markConverted({ marks: [{ id: a.id, opId: null }, { id: randomUUID(), opId: null }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await caller.mapTrack.get({ id: a.id })).convertedOp).toBe(op);
    expect((await caller.mapTrack.markConverted({ marks: [{ id: a.id, opId: null }] })).tracks[0].convertedOp).toBeNull();
    await expect(caller.mapTrack.markConverted({ marks: [{ id: a.id, opId: "hide:3" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.mapTrack.markConverted({ marks: [{ id: a.id, opId: null }, { id: a.id, opId: op }] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/^TRACK_POINTS_INVALID/) });
  });
});

describe("access", () => {
  it("a course setter does everything and is recorded as the importer", async () => {
    await reset();
    const as = makeCaller(ctx.event, { user: setter, authEnabled: true, authMode: "proxy", identityEmail: setter.email });
    const [t] = (await as.mapTrack.import({ tracks: [item(6)] })).tracks;
    expect(t.createdBy).toBe(setter.id);
    expect((await as.mapTrack.list()).tracks).toHaveLength(1);
    await as.mapTrack.get({ id: t.id });
    await as.mapTrack.update({ id: t.id, name: "x" });
    const [l] = (await as.mapTrack.split({ id: t.id, index: 2 })).tracks;
    await as.mapTrack.markConverted({ marks: [{ id: l.id, opId: null }] });
    expect((await as.mapTrack.remove({ ids: [l.id] })).removed).toBe(1);
  });

  it("a viewer, a kiosk key and a stranger can neither read nor write", async () => {
    await reset();
    const [t] = (await caller.mapTrack.import({ tracks: [item(6)] })).tracks;
    const callers = [
      makeCaller(ctx.event, { user: viewer, authEnabled: true, authMode: "proxy", identityEmail: viewer.email }),
      makeCaller(ctx.event, { user: null, authEnabled: true, authMode: "proxy", kioskKey: KIOSK }),
      makeCaller(ctx.event, { user: stranger, authEnabled: true, authMode: "proxy", identityEmail: stranger.email }),
    ];
    const refused = { code: expect.stringMatching(/UNAUTHORIZED|FORBIDDEN/) };
    for (const c of callers) {
      await expect(c.mapTrack.list()).rejects.toMatchObject(refused);
      await expect(c.mapTrack.get({ id: t.id })).rejects.toMatchObject(refused);
      await expect(c.mapTrack.import({ tracks: [item(3)] })).rejects.toMatchObject(refused);
      await expect(c.mapTrack.update({ id: t.id, name: "x" })).rejects.toMatchObject(refused);
      await expect(c.mapTrack.split({ id: t.id, index: 2 })).rejects.toMatchObject(refused);
      await expect(c.mapTrack.remove({ ids: [t.id] })).rejects.toMatchObject(refused);
      await expect(c.mapTrack.markConverted({ marks: [{ id: t.id, opId: null }] })).rejects.toMatchObject(refused);
    }
    expect(await caller.mapTrack.get({ id: t.id })).toMatchObject({ name: "Loop", version: t.version });
  });
});

describe("ownership (§1.3)", () => {
  it("leaves the tracks out of the checkout snapshot", async () => {
    await reset();
    const [t] = (await caller.mapTrack.import({ tracks: [item(5, `snap-${suffix}`)] })).tracks;
    const snapshot = await exportEventSnapshot(ctx.db, ctx.event);
    const text = JSON.stringify(snapshot, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toContain(t.id);
    expect(text).not.toContain(`snap-${suffix}`);
    expect(Object.keys(snapshot.tables).filter((k) => /gps/i.test(k))).toEqual([]);
  });

  it("journals nothing", async () => {
    expect(await ctx.db.journalEntry.count({ where: { eventId: ctx.eventId } })).toBe(journalBefore);
  });
});
