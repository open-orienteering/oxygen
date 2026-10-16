/**
 * Backfill of pre-pipeline map rows (docs/map-storage.md §6.7): legacy
 * `club_map_files` become series + version, `map_files` get source and
 * document pins (and a club version pin when the bytes match), failures
 * are reported per row, re-runs only revisit what is still missing, and
 * the Maintenance procedures gate and drive it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import {
  backfillStatus,
  finishBackfill,
  listBackfillItems,
  planBackfill,
  resetBackfillState,
  runBackfill,
  startBackfill,
  type BackfillItemResult,
} from "../../map-store/backfill.js";
import type { AuthUser } from "../../auth.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const UPLOADED_AT = new Date("2025-01-01T10:00:00Z");

let ctx: TestEventContext;
let other: TestEventContext;
let removed: TestEventContext;
let admin: AuthUser;
let member: AuthUser;
const suffix = randomBytes(3).toString("hex");
const EMAIL_DOMAIN = `@map-backfill-${suffix}.example`;

let clubBytes: Buffer;
let clubHash: string;
let eventOnlyBytes: Buffer;
let eventOnlyHash: string;
const garbage = (tag: string) => Buffer.concat([Buffer.from([0xad, 0x0c]), Buffer.from(tag), randomBytes(32)]);
let garbageClub: Buffer;
let garbageEvent: Buffer;

let clubRowId: bigint;
let garbageClubRowId: bigint;
let eventRowFromClub: bigint;
let eventRowOwn: bigint;
let eventRowGarbage: bigint;
let otherEventRow: bigint;
let removedEventRow: bigint;

const sourceHashes = () => [clubHash, eventOnlyHash, sha256(garbageClub), sha256(garbageEvent)];

beforeAll(async () => {
  ctx = await createTestEvent("map_backfill");
  other = await createTestEvent("map_backfill_other");
  removed = await createTestEvent("map_backfill_removed");
  await removed.db.event.update({ where: { id: removed.eventId }, data: { removed: true } });

  admin = await ctx.db.user.create({ data: { email: `admin${EMAIL_DOMAIN}`, displayName: "admin", isAdmin: true, active: true } });
  member = await ctx.db.user.create({ data: { email: `member${EMAIL_DOMAIN}`, displayName: "member", isAdmin: false, active: true } });

  const base = readFileSync(FIXTURE);
  clubBytes = Buffer.concat([base, Buffer.from(`map-backfill-club-${suffix}`)]);
  clubHash = sha256(clubBytes);
  eventOnlyBytes = Buffer.concat([base, Buffer.from(`map-backfill-event-${suffix}`)]);
  eventOnlyHash = sha256(eventOnlyBytes);
  garbageClub = garbage(`club-${suffix}`);
  garbageEvent = garbage(`event-${suffix}`);

  // Legacy library rows: bytes only, no series, no file_hash.
  clubRowId = (await ctx.db.clubMapFile.create({
    data: {
      name: `Backfill club ${suffix}`, fileName: "club-a.ocd", fileData: clubBytes, sizeBytes: clubBytes.length,
      colorProfile: "isom", colorOverrides: { above: ["brown"] }, northLinesBelow: false, rotationCorrection: 2.5,
      uploadedBy: admin.id, uploadedAt: UPLOADED_AT,
    },
    select: { id: true },
  })).id;
  garbageClubRowId = (await ctx.db.clubMapFile.create({
    data: { name: `Backfill garbage ${suffix}`, fileName: "broken.ocd", fileData: garbageClub, sizeBytes: garbageClub.length },
    select: { id: true },
  })).id;

  // Legacy event rows: one copied from the club map (file_hash known), one
  // of its own (nothing known, no name), one unreadable; plus one in
  // another event and one in a soft-deleted event.
  const mk = (eventId: bigint, data: Record<string, unknown>) =>
    ctx.db.mapFile.create({ data: { eventId, fileData: Buffer.alloc(0), ...data } as never, select: { id: true } }).then((r) => r.id);
  eventRowFromClub = await mk(ctx.eventId, { fileName: "club-copy.ocd", fileData: clubBytes, fileHash: clubHash, fromClubLibrary: true, uploadedAt: UPLOADED_AT });
  eventRowOwn = await mk(ctx.eventId, { fileName: "", fileData: eventOnlyBytes });
  eventRowGarbage = await mk(ctx.eventId, { fileName: "broken.ocd", fileData: garbageEvent });
  otherEventRow = await mk(other.eventId, { fileName: "other.ocd", fileData: clubBytes });
  removedEventRow = await mk(removed.eventId, { fileName: "gone.ocd", fileData: clubBytes });
}, 60_000);

afterAll(async () => {
  resetBackfillState();
  await ctx.cleanup();
  await other.cleanup();
  await removed.cleanup();
  await ctx.db.clubMapFile.deleteMany({ where: { name: { contains: suffix } } });
  await ctx.db.clubMap.deleteMany({ where: { name: { contains: suffix } } });
  await ctx.db.mapImportJob.deleteMany({ where: { sourceHash: { in: sourceHashes() } } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash: { in: sourceHashes() } } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: { in: sourceHashes() } } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await disconnect();
}, 30_000);

const byId = (results: BackfillItemResult[], kind: "club" | "event", id: bigint) =>
  results.find((r) => r.kind === kind && r.id === id.toString());

describe("plan and dry run", () => {
  it("counts what is missing, club rows first, events restricted by filter", async () => {
    const plan = await planBackfill(ctx.db, { eventId: ctx.eventId });
    expect(plan.clubRows).toBeGreaterThanOrEqual(2);
    expect(plan.eventRows).toBe(3);

    const items = await listBackfillItems(ctx.db, { eventId: ctx.eventId });
    const kinds = items.map((i) => i.kind);
    expect(kinds.lastIndexOf("club")).toBeLessThan(kinds.indexOf("event"));
    const events = items.filter((i) => i.kind === "event");
    expect(events.map((i) => i.id)).toEqual([eventRowFromClub, eventRowOwn, eventRowGarbage].map(String));
    expect(events[1].name).toBe(`${ctx.nameId}: map`);
    expect(events[0].name).toBe(`${ctx.nameId}: club-copy.ocd`);
    expect(items.find((i) => i.id === clubRowId.toString())).toMatchObject({ kind: "club", name: `Backfill club ${suffix}`, eventId: null });

    expect((await listBackfillItems(ctx.db, { eventId: ctx.eventId, limit: 1 })).length).toBe(1);
  });

  it("a dry run writes nothing", async () => {
    const run = await runBackfill(ctx.db, { eventId: ctx.eventId, dryRun: true });
    expect(run).toMatchObject({ state: "done", dryRun: true, processed: 0, done: 0, failed: 0 });
    expect(run.total).toBeGreaterThanOrEqual(5);
    const row = await ctx.db.clubMapFile.findUniqueOrThrow({ where: { id: clubRowId }, select: { clubMapId: true, fileHash: true } });
    expect(row).toEqual({ clubMapId: null, fileHash: null });
    expect(await ctx.db.mapSource.count({ where: { fileHash: clubHash } })).toBe(0);
  });
});

describe("a run", () => {
  const results: BackfillItemResult[] = [];

  it("imports club rows into series + version and event rows into pins, reporting failures per row", async () => {
    const run = await runBackfill(ctx.db, { eventId: ctx.eventId, onItem: (r) => results.push(r) });
    expect(run.state).toBe("done");
    expect(run.processed).toBe(run.total);
    expect(run.current).toBeNull();
    expect(run.finishedAt).not.toBeNull();

    // Club row → series copied from the legacy settings, version 1 labelled from the row.
    const club = byId(results, "club", clubRowId)!;
    expect(club).toMatchObject({ outcome: "done", deduplicated: false, error: null });
    expect(club.documentHash).toMatch(/^[0-9a-f]{64}$/);
    const row = await ctx.db.clubMapFile.findUniqueOrThrow({ where: { id: clubRowId }, select: { clubMapId: true, fileHash: true } });
    expect(row.fileHash).toBe(clubHash);
    const series = await ctx.db.clubMap.findUniqueOrThrow({ where: { id: row.clubMapId! }, include: { versions: true } });
    expect(series).toMatchObject({
      name: `Backfill club ${suffix}`, colourProfile: "isom", colourOverrides: { above: ["brown"] }, northLinesBelow: false,
      rotationCorrection: 2.5, createdBy: admin.id, createdAt: UPLOADED_AT,
    });
    expect(series.versions).toHaveLength(1);
    expect(series.versions[0]).toMatchObject({ seq: 1, label: "club-a.ocd", sourceHash: clubHash, documentHash: club.documentHash, uploadedBy: admin.id, uploadedAt: UPLOADED_AT });
    const source = await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash: clubHash } });
    expect(source).toMatchObject({ kind: "ocad", fileName: "club-a.ocd", uploadedBy: admin.id, createdAt: UPLOADED_AT });

    // Unreadable club row: series created, no version, failure recorded.
    const broken = byId(results, "club", garbageClubRowId)!;
    expect(broken.outcome).toBe("failed");
    expect(broken.error).toBeTruthy();
    const brokenRow = await ctx.db.clubMapFile.findUniqueOrThrow({ where: { id: garbageClubRowId }, select: { clubMapId: true } });
    expect(brokenRow.clubMapId).not.toBeNull();
    expect(await ctx.db.clubMapVersion.count({ where: { clubMapId: brokenRow.clubMapId! } })).toBe(0);

    // Event row with the club's bytes: dedup against the club's document, pinned to its version.
    const fromClub = byId(results, "event", eventRowFromClub)!;
    expect(fromClub).toMatchObject({ outcome: "done", deduplicated: true, documentHash: club.documentHash });
    const fromClubRow = await ctx.db.mapFile.findUniqueOrThrow({ where: { id: eventRowFromClub }, select: { sourceHash: true, documentHash: true, clubMapVersionId: true } });
    expect(fromClubRow).toEqual({ sourceHash: clubHash, documentHash: club.documentHash, clubMapVersionId: series.versions[0].id });

    // Event-only row: hashed, named, imported, no club pin.
    const own = byId(results, "event", eventRowOwn)!;
    expect(own).toMatchObject({ outcome: "done", deduplicated: false });
    const ownRow = await ctx.db.mapFile.findUniqueOrThrow({ where: { id: eventRowOwn }, select: { fileHash: true, sourceHash: true, documentHash: true, clubMapVersionId: true } });
    expect(ownRow).toEqual({ fileHash: eventOnlyHash, sourceHash: eventOnlyHash, documentHash: own.documentHash, clubMapVersionId: null });
    expect((await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash: eventOnlyHash } })).fileName).toBe("map.ocd");
    expect(own.documentHash).not.toBe(club.documentHash);

    // Unreadable event row stays unpinned; the failure names it.
    const brokenEvent = byId(results, "event", eventRowGarbage)!;
    expect(brokenEvent.outcome).toBe("failed");
    expect((await ctx.db.mapFile.findUniqueOrThrow({ where: { id: eventRowGarbage }, select: { documentHash: true } })).documentHash).toBeNull();
    expect(run.failures.map((f) => f.id)).toEqual(expect.arrayContaining([garbageClubRowId.toString(), eventRowGarbage.toString()]));
    expect(run.done).toBeGreaterThanOrEqual(3);
    expect(run.failed).toBe(run.failures.length);

    // Out of scope: another event (filtered) and a soft-deleted event.
    for (const id of [otherEventRow, removedEventRow]) {
      expect((await ctx.db.mapFile.findUniqueOrThrow({ where: { id }, select: { documentHash: true } })).documentHash).toBeNull();
    }
  });

  it("a second run revisits only what is still missing", async () => {
    const items = await listBackfillItems(ctx.db, { eventId: ctx.eventId });
    const ids = items.map((i) => `${i.kind}:${i.id}`);
    expect(ids).toContain(`club:${garbageClubRowId}`);
    expect(ids).toContain(`event:${eventRowGarbage}`);
    expect(ids).not.toContain(`club:${clubRowId}`);
    expect(ids).not.toContain(`event:${eventRowFromClub}`);
    expect(ids).not.toContain(`event:${eventRowOwn}`);

    const again: BackfillItemResult[] = [];
    const run = await runBackfill(ctx.db, { eventId: ctx.eventId, onItem: (r) => again.push(r) });
    expect(run.done).toBe(0);
    expect(byId(again, "club", garbageClubRowId)?.outcome).toBe("failed");
    const seriesId = (await ctx.db.clubMapFile.findUniqueOrThrow({ where: { id: garbageClubRowId }, select: { clubMapId: true } })).clubMapId!;
    expect(await ctx.db.clubMap.count({ where: { name: `Backfill garbage ${suffix}` } })).toBe(1);
    expect(seriesId).toBeTruthy();
    expect(await ctx.db.clubMapVersion.count({ where: { sourceHash: clubHash } })).toBe(1);
  });

  it("without an event filter the other event's row is imported by dedup; the deleted event's never", async () => {
    const all: BackfillItemResult[] = [];
    await runBackfill(ctx.db, { onItem: (r) => all.push(r) });
    const otherResult = byId(all, "event", otherEventRow)!;
    expect(otherResult).toMatchObject({ outcome: "done", deduplicated: true });
    const otherRow = await ctx.db.mapFile.findUniqueOrThrow({ where: { id: otherEventRow }, select: { documentHash: true, clubMapVersionId: true } });
    expect(otherRow.documentHash).toBe(otherResult.documentHash);
    expect(otherRow.clubMapVersionId).not.toBeNull();
    expect(byId(all, "event", removedEventRow)).toBeUndefined();
    expect((await ctx.db.mapFile.findUniqueOrThrow({ where: { id: removedEventRow }, select: { documentHash: true } })).documentHash).toBeNull();
  });
});

describe("mapImport.backfillStatus / backfillStart", () => {
  it("are admin-only", async () => {
    const asMember = makeCaller(null, { user: member, authEnabled: true, authMode: "proxy" });
    await expect(asMember.mapImport.backfillStatus()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(asMember.mapImport.backfillStart()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("report the plan, run in the background, and refuse a second concurrent run", async () => {
    resetBackfillState();
    const asAdmin = makeCaller(null, { user: admin, authEnabled: true, authMode: "proxy" });
    const before = await asAdmin.mapImport.backfillStatus();
    expect(before.run).toBeNull();
    expect(before.plan.eventRows).toBeGreaterThanOrEqual(1);

    const started = await asAdmin.mapImport.backfillStart({ limit: 1 });
    expect(started.run?.state).toBe("running");
    await expect(asAdmin.mapImport.backfillStart()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(startBackfill(ctx.db)).toBeNull();

    const finished = await finishBackfill();
    expect(finished?.state).toBe("done");
    expect(finished?.total).toBe(1);
    expect(backfillStatus()).toBe(finished);
    const after = await asAdmin.mapImport.backfillStatus();
    expect(after.run).toMatchObject({ state: "done", total: 1, processed: 1 });
    expect(after.run?.finishedAt).toBeTruthy();
  });
});
