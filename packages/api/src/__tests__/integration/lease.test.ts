/**
 * Per-event lease integration tests (pivot Step 4).
 *
 * Same two-node harness as journal-shipping.test.ts: node A is the Prisma
 * singleton (exercised through real tRPC callers), node B is a second
 * physical database. The lease peer + shipping transport are injected
 * in-process but call the same functions the HTTP endpoints use.
 *
 * Covers: the raceProcedure guard (typed rejection on a non-holder,
 * events.push unaffected), acquire/release/double-checkout, the full
 * checkout snapshot import (rows, seq counters, journal cursor), writes
 * during a lease shipping to the peer, the checkin barrier (blocked while
 * unshipped, releasing both sides when drained), and forceTakeover.
 *
 * Maps (docs/map-storage.md §7.2): the checkout carries the event's pinned
 * `map_files` row and its source + document blobs by hash, the venue
 * serves the document route from its copy with the kiosk key, a
 * pre-pipeline row is skipped, bytes that do not match their hash fail
 * the checkout and release the peer lease, an exporter without the map
 * part still checks out, and a re-checkout fetches nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { Client } from "pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHash, randomBytes, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import {
  acquireLease,
  releaseLease,
  getActiveLease,
  assertRaceWritable,
  exportEventSnapshot,
  importEventSnapshot,
  _setLeasePeerFactory,
  type LeasePeer,
} from "../../sync/lease.js";
import {
  _setPeerTransportFactory,
  type PeerTransport,
} from "../../sync/shipper.js";
import { refreshCloudOwnedSettings } from "../../sync/settingsRefresh.js";
import {
  ingestJournalEntries,
  listJournalEntriesSince,
} from "../../routers/events.js";
import type { EventRef } from "../../db.js";
import { importAndStoreOcad } from "../../map-store/documents.js";
import { exportBlobSlice } from "../../sync/snapshotMaps.js";
import { exportGraphicSlice, exportPeerBlobSlice } from "../../sync/snapshotGraphics.js";
import { registerVenueForwarder } from "../../sync/venueForwarder.js";
import { registerMapDocumentRoutes, resetDocumentAccessCache } from "../../map-store/routes.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const mapSuffix = randomBytes(4).toString("hex");
const KIOSK_KEY = `kiosk-lease-${mapSuffix}`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let mapFixture: Buffer; // per-run trailer: content-addressed rows are global
let sourceHash: string;
let documentHash: string;
const DFP = (k: string) => `ocad:999.9:lease${mapSuffix}${k}`;
const DLIB = "ISOM2017-2@2026.10.1";

const PEER_URL = "http://peer.test";
const PATCH_VERSION = 2n ** 60n + 12_345n;
// Layout rows (G18): tokens above 2^53, so a JSON number would round them.
const TEMPLATE_VERSION = 2n ** 60n + 101n;
const SHEET_VERSION = 2n ** 60n + 202n;
const OBJECT_VERSION = 2n ** 60n + 303n;
const EVENT_SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"><rect width="2" height="1"/><!--${mapSuffix}--></svg>`);
const CLUB_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(64)]);
let eventGraphicId: bigint; // B's event graphic, drawn by the template
let clubGraphicId: bigint; // a club graphic the course object draws
let unreferencedClubGraphicId: bigint;
let templateBId: string;
let sheetBId: string;
let objectBId: string;
const PATCH_OPS = { "hide:3": { op: "hide", sourceIndex: 3 } };

let ctx: TestEventContext; // node A (this process's node id: "cloud")
let caller: ReturnType<typeof makeCaller>;
let dbB: PrismaClient; // node B (the peer)
let eventB: EventRef; // the event that lives on B and gets checked out
const CHECKOUT_NAME = `oxygen_test_lease_co_${randomUUID().slice(0, 8)}`;

async function provisionNodeB(): Promise<string> {
  const aUrl = new URL(process.env.DATABASE_URL!);
  const bUrl = new URL(aUrl.toString());
  // Beside node A's database, so a run against another test database
  // (INTEGRATION_DATABASE_URL) has its own node B.
  const bName = `${aUrl.pathname.replace(/^\//, "")}_b`;
  bUrl.pathname = `/${bName}`;
  const admin = new Client({ connectionString: aUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${bName}"`);
  } catch (err) {
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await admin.end();
  }
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: bUrl.toString() },
  });
  return bUrl.toString();
}

/** In-process peer: B's lease surface via the same functions the router uses. */
function leasePeerToB(): LeasePeer {
  return {
    acquire: async (_nameId, holder) => {
      await acquireLease(dbB, eventB.id, holder);
    },
    release: async (_nameId, holder) => {
      await releaseLease(dbB, eventB.id, { expectedHolder: holder });
    },
    exportSnapshot: async () => exportEventSnapshot(dbB, eventB),
    exportSettings: async () =>
      (await dbB.event.findUniqueOrThrow({
        where: { id: eventB.id },
      })) as unknown as Record<string, unknown>,
    exportBlob: async (_nameId, input) => exportPeerBlobSlice(dbB, eventB.id, input),
  };
}

/** The same peer, its snapshot through a JSON round trip as over HTTP (BigInt → number). */
function jsonLeasePeerToB(): LeasePeer {
  return {
    ...leasePeerToB(),
    exportSnapshot: async () => JSON.parse(JSON.stringify(await exportEventSnapshot(dbB, eventB))),
  };
}

function transportToB(): PeerTransport {
  return {
    push: (_nameId, entries) => ingestJournalEntries(dbB, eventB, entries),
    since: (_nameId, cursor, limit) =>
      listJournalEntriesSince(dbB, eventB, cursor, limit),
  };
}

beforeAll(async () => {
  process.env.SYNC_PEER_URL = PEER_URL;
  process.env.SYNC_SHARED_SECRET = "test-sync-secret";

  ctx = await createTestEvent("lease");
  caller = makeCaller(ctx.event);
  const cls = await caller.class.create({ name: "H21" });
  await caller.runner.create({
    name: "Guarded Greta",
    classId: cls.id,
    cardNo: 800100,
    clubName: "OK Lease",
  });

  const bUrl = await provisionNodeB();
  dbB = new PrismaClient({ adapter: new PrismaPg({ connectionString: bUrl }) });
  await dbB.event.deleteMany({
    where: { nameId: { startsWith: "oxygen_test_lease" } },
  });

  // The checkout-source event lives on node B with reference + race data.
  const rowB = await dbB.event.create({
    data: {
      nameId: CHECKOUT_NAME,
      name: "Checkout Source",
      date: new Date("2026-01-01T00:00:00Z"),
      kind: "competition",
    },
    select: { id: true, nameId: true, zeroTime: true },
  });
  eventB = { id: rowB.id, nameId: rowB.nameId, zeroTime: rowB.zeroTime };
  const clsB = await dbB.class.create({
    data: { eventId: eventB.id, name: "D21" },
    select: { id: true, seq: true },
  });
  await dbB.runner.create({
    data: {
      eventId: eventB.id,
      name: "Snapshot Stina",
      classId: clsB.id,
      cardNo: 800200,
      clubName: "OK Source",
    },
  });
  await dbB.punch.create({
    data: {
      eventId: eventB.id,
      cardNo: 800200,
      controlCode: 31,
      time: 36000,
      source: "online_input",
    },
  });

  // The event's map on B: source + document stored, pinned by map_files,
  // plus a row without a source (a soft-deleted event's tombstone shape
  // after E5) that the snapshot leaves behind.
  mapFixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`lease-${mapSuffix}`)]);
  const stored = await importAndStoreOcad(dbB, mapFixture, "lease.ocd");
  sourceHash = stored.sourceHash;
  documentHash = stored.documentHash;
  await dbB.mapFile.create({
    data: { eventId: eventB.id, fileName: "old.ocd", uploadedAt: new Date("2025-01-01T00:00:00Z") },
  });
  await dbB.mapFile.create({
    data: {
      eventId: eventB.id,
      fileName: "lease.ocd",
      sourceHash,
      documentHash,
      scale: 10000,
      rotationCorrection: 1.5,
    },
  });
  await dbB.event.update({ where: { id: eventB.id }, data: { kioskKey: KIOSK_KEY } });
  // The event's map patch on B (docs/map-patches.md §3.4), its token above 2^53.
  await dbB.mapPatch.create({
    data: { eventId: eventB.id, documentHash, enabled: false, ops: PATCH_OPS, symbols: {}, version: PATCH_VERSION },
  });
  // Layout on B (G18, docs/map-storage.md §7.2): a template drawing an
  // event graphic, a class printing on it, a sheet without a window centre,
  // a course object drawing a club graphic, and a club graphic nothing draws.
  const graphicB = async (eventId: bigint | null, name: string, mime: string, data: Buffer) =>
    (await dbB.graphic.create({ data: { eventId, name, mime, data, sizeBytes: data.length }, select: { id: true } })).id;
  eventGraphicId = await graphicB(eventB.id, "event.svg", "image/svg+xml", EVENT_SVG);
  clubGraphicId = await graphicB(null, `club-${mapSuffix}.png`, "image/png", CLUB_PNG);
  unreferencedClubGraphicId = await graphicB(null, `unused-${mapSuffix}.png`, "image/png", CLUB_PNG);
  const templateB = await dbB.mapTemplate.create({
    data: {
      eventId: eventB.id,
      name: "A4",
      printScale: 10000,
      objects: [{ id: "logo", anchor: "page", kind: "image", graphicId: Number(eventGraphicId), x: 10, y: 10, width: 20, height: 10 }],
      version: TEMPLATE_VERSION,
    },
    select: { id: true },
  });
  templateBId = templateB.id;
  const courseB = await dbB.course.create({ data: { eventId: eventB.id, name: "Blå" }, select: { id: true } });
  await dbB.class.update({ where: { id: clsB.id }, data: { courseId: courseB.id, sheetTemplateId: templateB.id, printScale: 7500 } });
  sheetBId = (
    await dbB.courseMap.create({
      data: { eventId: eventB.id, name: "Blå karta", courseId: courseB.id, templateId: templateB.id, version: SHEET_VERSION },
      select: { id: true },
    })
  ).id;
  objectBId = (
    await dbB.courseObject.create({
      data: {
        eventId: eventB.id,
        kind: "image",
        geometry: [{ x: 0, y: 0 }, { x: 10, y: 5 }],
        props: { graphicId: Number(clubGraphicId) },
        scope: { all: true },
        version: OBJECT_VERSION,
      },
      select: { id: true },
    })
  ).id;

  // Club decisions on the cloud (fingerprints no real symbol has), and on
  // the venue one stale copy of the same key plus a row the cloud lacks.
  await dbB.clubSymbolDecision.createMany({
    data: [
      { fingerprint: DFP("a"), libraryVersion: DLIB, canonicalId: "cloud-a", decidedAt: new Date("2026-06-01T00:00:00Z") },
      { fingerprint: DFP("b"), libraryVersion: DLIB, canonicalId: null, decidedAt: new Date("2026-06-01T00:00:00Z") },
    ],
  });
  await ctx.db.clubSymbolDecision.createMany({
    data: [
      { fingerprint: DFP("a"), libraryVersion: DLIB, canonicalId: "venue-stale", decidedAt: new Date("2026-01-01T00:00:00Z") },
      { fingerprint: DFP("venue"), libraryVersion: DLIB, canonicalId: "venue-only", decidedAt: new Date("2026-01-01T00:00:00Z") },
    ],
  });

  _setLeasePeerFactory(() => leasePeerToB());
  _setPeerTransportFactory(() => transportToB());
}, 60_000);

afterAll(async () => {
  _setLeasePeerFactory(null);
  _setPeerTransportFactory(null);
  delete process.env.SYNC_PEER_URL;
  delete process.env.SYNC_SHARED_SECRET;
  await ctx.db.event.deleteMany({ where: { nameId: CHECKOUT_NAME } });
  await dbB.event.delete({ where: { id: eventB.id } }).catch(() => {});
  // Club graphics outlive the event; the box holds copies under B's ids.
  const clubIds = [clubGraphicId, unreferencedClubGraphicId].filter((id) => id !== undefined);
  await dbB.graphic.deleteMany({ where: { id: { in: clubIds } } });
  await ctx.db.graphic.deleteMany({ where: { id: { in: clubIds }, eventId: null } });
  // Blobs outlive their pins (append-only); remove this run's on both nodes.
  for (const db of [ctx.db, dbB] as const) {
    await db.clubSymbolDecision.deleteMany({ where: { fingerprint: { contains: `lease${mapSuffix}` } } });
    await db.mapDocument.deleteMany({ where: { sourceHash } });
    await db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
  }
  await dbB.$disconnect();
  await ctx.cleanup();
  await disconnect();
});

describe("raceProcedure guard", () => {
  it("rejects race-critical mutations when another node holds the lease", async () => {
    await acquireLease(ctx.db, ctx.eventId, "venue-99");
    try {
      await expect(
        caller.race.recordFinish({ id: 1, finishTimeAbsolute: 366000 }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(
        caller.runner.create({
          name: "Blocked Bo",
          classId: 1,
          clubName: "X",
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(
        caller.class.create({ name: "Blocked class" }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      // The journal ingestion sink stays open — shipped/drained entries
      // must land on every node regardless of the lease.
      const res = await caller.events.push({
        events: [
          {
            id: randomUUID(),
            type: "punch.recorded",
            competitionId: ctx.nameId,
            stationId: "station-x",
            timestamp: Date.now(),
            payload: { cardNo: 800100, controlCode: 55, time: 361000 },
          },
        ],
      });
      expect(res.failed).toEqual([]);
      expect(res.synced.length).toBe(1);
    } finally {
      await releaseLease(ctx.db, ctx.eventId, { forced: true });
    }
  });

  it("writes resume after release; double-acquire conflicts", async () => {
    const r = await caller.runner.create({
      name: "Resumed Rune",
      classId: 1,
      clubName: "OK Igen",
    });
    expect(r.id).toBeGreaterThan(0);

    await acquireLease(ctx.db, ctx.eventId, "venue-99");
    try {
      await expect(
        acquireLease(ctx.db, ctx.eventId, "venue-100"),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await releaseLease(ctx.db, ctx.eventId, { forced: true });
    }
  });
});

/** Undo a checkout that succeeded on both sides, so the lifecycle starts clean. */
async function undoCheckout(): Promise<void> {
  const local = await ctx.db.event.findUnique({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
  if (local) await ctx.db.event.delete({ where: { id: local.id } });
  if (await getActiveLease(dbB, eventB.id)) await releaseLease(dbB, eventB.id, { forced: true });
  // Club graphics outlive the event; the next checkout fetches them afresh.
  await ctx.db.graphic.deleteMany({ where: { id: { in: [clubGraphicId, unreferencedClubGraphicId] }, eventId: null } });
}

describe("checkout maps: failure and interop", () => {
  it("fails on bytes that do not match their hash, releases the peer lease and stores nothing", async () => {
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      exportBlob: async (nameId, input) => {
        const slice = await leasePeerToB().exportBlob(nameId, input);
        const bytes = Buffer.from(slice.base64, "base64");
        bytes[0] ^= 0xff;
        return { ...slice, base64: bytes.toString("base64") };
      },
    }));
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringMatching(/arrived with hash/),
      });
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
    }
    expect(await getActiveLease(dbB, eventB.id)).toBeNull();
    expect(await ctx.db.event.findUnique({ where: { nameId: CHECKOUT_NAME } })).toBeNull();
    expect(await ctx.db.mapSource.count({ where: { fileHash: sourceHash } })).toBe(0);
    expect(await ctx.db.mapDocument.count({ where: { hash: documentHash } })).toBe(0);
  });

  it("checks out from an exporter without the map part (no map, as before)", async () => {
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      exportSnapshot: async () => ({ ...(await exportEventSnapshot(dbB, eventB)), maps: undefined }),
    }));
    try {
      const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME });
      expect(res.maps).toEqual({ files: 0, sources: 0, documents: 0, fetchedBytes: 0, skipped: 0, decisions: 0, patches: 0 });
      const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
      expect(await ctx.db.mapFile.count({ where: { eventId: local.id } })).toBe(0);
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
      await undoCheckout();
    }
  });

  it("checks out from a v0.6.0 exporter whose rows still carry the columns E5 dropped", async () => {
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      exportSnapshot: async () => {
        const snap = await exportEventSnapshot(dbB, eventB);
        return {
          ...snap,
          event: { ...snap.event, mapPipeline: "vector", overprintCutsVersion: 3 },
          tables: { ...snap.tables, course: snap.tables.course.map((c) => ({ ...c, geometry: { type: "FeatureCollection", features: [] }, geometrySource: "editor" })) },
          maps: snap.maps && {
            ...snap.maps,
            files: snap.maps.files.map((m) => ({ ...m, fileHash: m.sourceHash, renderKey: "rk", colorProfile: "auto", colorOverrides: {}, northLinesBelow: true })),
          },
        };
      },
    }));
    try {
      const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME });
      expect(res.maps).toMatchObject({ files: 1 });
      const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
      expect(await ctx.db.mapFile.findMany({ where: { eventId: local.id }, select: { sourceHash: true } })).toEqual([{ sourceHash }]);
      expect(await ctx.db.course.count({ where: { eventId: local.id } })).toBe(await dbB.course.count({ where: { eventId: eventB.id } }));
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
      await undoCheckout();
      // The lifecycle below fetches the blobs afresh and counts the bytes.
      await ctx.db.mapDocument.deleteMany({ where: { hash: documentHash } });
      await ctx.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
    }
  });

  it("checks out from an exporter without templates, sheets, tokens or graphics: the class's print template is NULL", async () => {
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      exportSnapshot: async () => {
        const snap = await exportEventSnapshot(dbB, eventB);
        const { mapTemplate: _t, courseMap: _m, ...tables } = snap.tables;
        return { ...snap, tables: tables as typeof snap.tables, versions: undefined, graphics: undefined };
      },
    }));
    try {
      const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME });
      expect(res.graphics).toEqual({ rows: 0, fetchedBytes: 0 });
      const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
      const cls = await ctx.db.class.findFirstOrThrow({ where: { eventId: local.id, name: "D21" } });
      expect(cls).toMatchObject({ sheetTemplateId: null, printScale: 7500 });
      expect(await ctx.db.mapTemplate.count({ where: { eventId: local.id } })).toBe(0);
      expect(await ctx.db.graphic.count({ where: { eventId: local.id } })).toBe(0);
      // The course object travels as before G18, its token from the row.
      expect(await ctx.db.courseObject.count({ where: { eventId: local.id } })).toBe(1);
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
      await undoCheckout();
      // The lifecycle below fetches the blobs afresh and counts the bytes.
      await ctx.db.mapDocument.deleteMany({ where: { hash: documentHash } });
      await ctx.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
    }
  });

  it("fails on graphic bytes that do not match their hash, releases the peer lease and stores nothing", async () => {
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      exportBlob: async (nameId, input) => {
        const slice = await leasePeerToB().exportBlob(nameId, input);
        if (input.table !== "graphics") return slice;
        const bytes = Buffer.from(slice.base64, "base64");
        bytes[0] ^= 0xff;
        return { ...slice, base64: bytes.toString("base64") };
      },
    }));
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringMatching(/graphic \d+ arrived with hash/),
      });
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
    }
    expect(await getActiveLease(dbB, eventB.id)).toBeNull();
    expect(await ctx.db.event.findUnique({ where: { nameId: CHECKOUT_NAME } })).toBeNull();
    expect(await ctx.db.graphic.count({ where: { id: clubGraphicId, eventId: null } })).toBe(0);
    // Fetched map blobs are inserted only by the import, which never ran.
    expect(await ctx.db.mapSource.count({ where: { fileHash: sourceHash } })).toBe(0);
  });

  it("exportBlob answers a graphic only for the event's own and the club graphics it draws", async () => {
    const other = await dbB.event.create({
      data: { nameId: `oxygen_test_lease_gother_${mapSuffix}`, name: "Other", date: new Date("2026-01-01T00:00:00Z"), kind: "competition" },
      select: { id: true },
    });
    const g = (id: bigint, start = 0) => ({ table: "graphics" as const, id: id.toString(), start, length: 1024 });
    try {
      await expect(exportGraphicSlice(dbB, other.id, g(eventGraphicId))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(exportGraphicSlice(dbB, other.id, g(clubGraphicId))).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await dbB.event.delete({ where: { id: other.id } });
    }
    await expect(exportGraphicSlice(dbB, eventB.id, g(unreferencedClubGraphicId))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(exportGraphicSlice(dbB, eventB.id, g(10n ** 15n))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const own = await exportGraphicSlice(dbB, eventB.id, g(eventGraphicId));
    expect(Buffer.from(own.base64, "base64").equals(EVENT_SVG)).toBe(true);
    expect(own.sizeBytes).toBe(EVENT_SVG.length);
    const club = await exportPeerBlobSlice(dbB, eventB.id, { ...g(clubGraphicId, 4), length: 8 });
    expect(Buffer.from(club.base64, "base64").equals(CLUB_PNG.subarray(4, 12))).toBe(true);
    await expect(exportGraphicSlice(dbB, eventB.id, g(eventGraphicId, EVENT_SVG.length))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("exportBlob answers only for blobs the event pins", async () => {
    const other = await dbB.event.create({
      data: { nameId: `oxygen_test_lease_other_${mapSuffix}`, name: "Other", date: new Date("2026-01-01T00:00:00Z"), kind: "competition" },
      select: { id: true },
    });
    try {
      await expect(exportBlobSlice(dbB, other.id, { table: "map_documents", hash: documentHash, start: 0, length: 16 })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(exportBlobSlice(dbB, other.id, { table: "map_sources", hash: sourceHash, start: 0, length: 16 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await dbB.event.delete({ where: { id: other.id } });
    }
    const head = await exportBlobSlice(dbB, eventB.id, { table: "map_sources", hash: sourceHash, start: 0, length: 16 });
    expect(Buffer.from(head.base64, "base64").equals(mapFixture.subarray(0, 16))).toBe(true);
    expect(head.sizeBytes).toBe(mapFixture.length);
    await expect(exportBlobSlice(dbB, eventB.id, { table: "map_sources", hash: sourceHash, start: mapFixture.length, length: 16 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("checkout → write → checkin lifecycle", () => {
  it("checkout imports the snapshot verbatim and takes the lease on both nodes", async () => {
    // The snapshot as HTTP delivers it: JSON, every BigInt a number.
    _setLeasePeerFactory(() => jsonLeasePeerToB());
    const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME }).finally(() => _setLeasePeerFactory(() => leasePeerToB()));
    expect(res.ok).toBe(true);
    expect(res.imported).toMatchObject({ mapTemplate: 1, courseMap: 1, courseObject: 1 });
    expect(res.graphics).toEqual({ rows: 2, fetchedBytes: EVENT_SVG.length + CLUB_PNG.length });
    expect(res.imported.runner).toBe(1);
    expect(res.imported.punch).toBe(1);
    expect(res.maps).toEqual({
      files: 1,
      sources: 1,
      documents: 1,
      fetchedBytes: mapFixture.length + (await dbB.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } })).sizeBytes,
      skipped: 1,
      decisions: await dbB.clubSymbolDecision.count(),
      patches: 1,
    });

    // Local copy: same UUIDs, same seqs, seq counters carried over.
    const localEvent = await ctx.db.event.findUnique({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true },
    });
    expect(localEvent).not.toBeNull();
    const runnerA = await ctx.db.runner.findFirst({
      where: { eventId: localEvent!.id, cardNo: 800200 },
    });
    const runnerB = await dbB.runner.findFirst({
      where: { eventId: eventB.id, cardNo: 800200 },
    });
    expect(runnerA!.id).toBe(runnerB!.id);
    expect(runnerA!.seq).toBe(runnerB!.seq);
    const seqRows = await ctx.db.eventSeq.findMany({
      where: { eventId: localEvent!.id },
    });
    expect(seqRows.length).toBeGreaterThan(0);

    // Lease held here (holder = this process's node id), mirrored on B.
    const leaseA = await getActiveLease(ctx.db, localEvent!.id);
    expect(leaseA?.holderNodeId).toBe("cloud");
    const leaseB = await getActiveLease(dbB, eventB.id);
    expect(leaseB?.holderNodeId).toBe("cloud");

    // On B (whose real node id differs), race writes are now rejected.
    const prevNodeId = process.env.NODE_ID;
    process.env.NODE_ID = "the-real-cloud";
    try {
      await expect(assertRaceWritable(dbB, eventB.id)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    } finally {
      if (prevNodeId === undefined) delete process.env.NODE_ID;
      else process.env.NODE_ID = prevNodeId;
    }
  });

  it("carries the pinned map: blobs byte-exact, map_files pin, venue-local metadata", async () => {
    const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
    const src = await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash: sourceHash } });
    expect(sha256(src.bytes)).toBe(sourceHash);
    expect(src.uploadedBy).toBeNull();
    const docA = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } });
    const docB = await dbB.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } });
    expect(Buffer.from(docA.bytes).equals(Buffer.from(docB.bytes))).toBe(true);
    expect(docA.header).toEqual(docB.header);
    expect(docA.libraryVersion).toBe(docB.libraryVersion);

    const files = await ctx.db.mapFile.findMany({ where: { eventId: local.id } });
    expect(files).toHaveLength(1); // the pre-pipeline row stayed behind
    expect(files[0]).toMatchObject({ fileName: "lease.ocd", sourceHash, documentHash, scale: 10000, rotationCorrection: 1.5, clubMapVersionId: null });
  });

  it("carries templates, sheets, course objects and the class print override verbatim, tokens exact over JSON (G18)", async () => {
    const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
    const strip = <T extends { eventId: bigint }>({ eventId: _e, ...rest }: T) => rest;
    const templateA = await ctx.db.mapTemplate.findUniqueOrThrow({ where: { id: templateBId } });
    expect(templateA.eventId).toBe(local.id);
    expect(strip(templateA)).toEqual(strip(await dbB.mapTemplate.findUniqueOrThrow({ where: { id: templateBId } })));
    expect(templateA.version).toBe(TEMPLATE_VERSION);
    const sheetA = await ctx.db.courseMap.findUniqueOrThrow({ where: { id: sheetBId } });
    expect(strip(sheetA)).toEqual(strip(await dbB.courseMap.findUniqueOrThrow({ where: { id: sheetBId } })));
    expect(sheetA).toMatchObject({ templateId: templateBId, windowCenter: null, version: SHEET_VERSION });
    const objectA = await ctx.db.courseObject.findUniqueOrThrow({ where: { id: objectBId } });
    expect(objectA.version).toBe(OBJECT_VERSION);
    expect(objectA.props).toEqual({ graphicId: Number(clubGraphicId) });
    const cls = await ctx.db.class.findFirstOrThrow({ where: { eventId: local.id, name: "D21" } });
    expect(cls).toMatchObject({ sheetTemplateId: templateBId, printScale: 7500 });
  });

  it("carries the event's graphic and the club graphic it draws, byte-exact under the cloud's ids; an unused club graphic stays behind (G18)", async () => {
    const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
    const own = await ctx.db.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } });
    expect(own).toMatchObject({ eventId: local.id, name: "event.svg", mime: "image/svg+xml", sizeBytes: EVENT_SVG.length });
    expect(Buffer.from(own.data).equals(EVENT_SVG)).toBe(true);
    const club = await ctx.db.graphic.findUniqueOrThrow({ where: { id: clubGraphicId } });
    expect(club).toMatchObject({ eventId: null, mime: "image/png" });
    expect(Buffer.from(club.data).equals(CLUB_PNG)).toBe(true);
    expect(await ctx.db.graphic.findUnique({ where: { id: unreferencedClubGraphicId } })).toBeNull();
    // A graphic uploaded on the box after the checkout takes an id past the cloud's.
    const next = await ctx.db.graphic.create({ data: { eventId: local.id, name: "venue.png", mime: "image/png", data: CLUB_PNG, sizeBytes: CLUB_PNG.length } });
    expect(next.id).toBeGreaterThan(clubGraphicId > eventGraphicId ? clubGraphicId : eventGraphicId);
    await ctx.db.graphic.delete({ where: { id: next.id } });
  });

  it("carries the map patch verbatim, its token exact, and serves it on the venue (map-patches.md §3.4)", async () => {
    const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true, nameId: true, zeroTime: true } });
    const rowB = await dbB.mapPatch.findUniqueOrThrow({ where: { eventId: eventB.id } });
    const rowA = await ctx.db.mapPatch.findUniqueOrThrow({ where: { eventId: local.id } });
    expect(rowA).toMatchObject({ id: rowB.id, documentHash, enabled: false, ops: PATCH_OPS, symbols: {}, version: PATCH_VERSION });

    const delivered = { version: PATCH_VERSION.toString(), patch: { documentHash, enabled: false, ops: PATCH_OPS, symbols: {} } };
    expect(await makeCaller(local).mapPatch.get()).toEqual(delivered);
    const server: FastifyInstance = Fastify({ logger: false });
    registerMapDocumentRoutes(server);
    await server.ready();
    const previousMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "proxy";
    try {
      const res = await server.inject({ method: "GET", url: `/api/maps/${CHECKOUT_NAME}/patch?k=${KIOSK_KEY}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(delivered);
      expect(res.headers.etag).toBe(`"${PATCH_VERSION}"`);
    } finally {
      if (previousMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousMode;
      await server.close();
    }
  });

  it("merges the club's symbol decisions: newer decided_at wins, nothing deleted", async () => {
    const rows = await ctx.db.clubSymbolDecision.findMany({ where: { fingerprint: { contains: `lease${mapSuffix}` } } });
    const byKey = Object.fromEntries(rows.map((r) => [r.fingerprint, r]));
    expect(byKey[DFP("a")]).toMatchObject({ canonicalId: "cloud-a", decidedBy: null, decidedAt: new Date("2026-06-01T00:00:00Z") });
    expect(byKey[DFP("b")]).toMatchObject({ canonicalId: null });
    expect(byKey[DFP("venue")]).toMatchObject({ canonicalId: "venue-only" });
  });

  it("lease.exportBlob serves the copy through the router, behind the shared secret", async () => {
    const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true, nameId: true, zeroTime: true } });
    const input = { table: "map_documents" as const, hash: documentHash, start: 0, length: 4096 };
    await expect(makeCaller(local).lease.exportBlob(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(makeCaller(local, { syncSecret: "wrong" }).lease.exportBlob(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const peer = makeCaller(local, { syncSecret: "test-sync-secret" });
    const slice = await peer.lease.exportBlob(input);
    const docB = await dbB.mapDocument.findUniqueOrThrow({ where: { hash: documentHash } });
    expect(slice.sizeBytes).toBe(docB.sizeBytes);
    expect(Buffer.from(slice.base64, "base64").equals(Buffer.from(docB.bytes).subarray(0, 4096))).toBe(true);
    await expect(peer.lease.exportBlob({ ...input, length: 4 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("serves the document route on the venue with the kiosk key", async () => {
    const server: FastifyInstance = Fastify({ logger: false });
    registerMapDocumentRoutes(server);
    await server.ready();
    const previousMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "proxy";
    resetDocumentAccessCache();
    try {
      const url = `/api/map-documents/${documentHash}?event=${CHECKOUT_NAME}`;
      const anonymous = await server.inject({ method: "GET", url });
      expect(anonymous.statusCode).toBe(401);
      const kiosk = await server.inject({ method: "GET", url: `${url}&k=${KIOSK_KEY}`, headers: { "accept-encoding": "identity" } });
      expect(kiosk.statusCode).toBe(200);
      expect(sha256(kiosk.rawPayload)).toBe(documentHash);
    } finally {
      if (previousMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousMode;
      resetDocumentAccessCache();
      await server.close();
    }
  });

  it("refreshes cloud-owned settings from the peer without touching the closure", async () => {
    const localEvent = await ctx.db.event.findUniqueOrThrow({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true, nameId: true, zeroTime: true },
    });

    // A cloud-side operator edits a receipt message (cloud-owned) AND the
    // zero time (closure — the venue owns it during the lease).
    await dbB.event.update({
      where: { id: eventB.id },
      data: { finishReceiptMessage: "Grattis!", zeroTime: 999999 },
    });

    const refreshed = await refreshCloudOwnedSettings(
      ctx.db,
      localEvent,
      leasePeerToB(),
    );
    expect(refreshed).toBe(true);

    const after = await ctx.db.event.findUniqueOrThrow({
      where: { id: localEvent.id },
      select: { finishReceiptMessage: true, zeroTime: true },
    });
    expect(after.finishReceiptMessage).toBe("Grattis!");
    // The closure field did NOT follow.
    expect(after.zeroTime).toBe(localEvent.zeroTime);

    // Restore B's zero time so later assertions stay valid.
    await dbB.event.update({
      where: { id: eventB.id },
      data: { zeroTime: eventB.zeroTime },
    });
  });

  it("does not refresh on a node that is not the holder", async () => {
    // ctx's own test event has no lease held by anyone.
    const refreshed = await refreshCloudOwnedSettings(
      ctx.db,
      ctx.event,
      leasePeerToB(),
    );
    expect(refreshed).toBe(false);
  });

  it("checkin is blocked while entries are unshipped, then releases both sides", async () => {
    const localEvent = await ctx.db.event.findUniqueOrThrow({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true, nameId: true, zeroTime: true },
    });
    const leaseCaller = makeCaller({
      id: localEvent.id,
      nameId: localEvent.nameId,
      zeroTime: localEvent.zeroTime,
    });

    // A race-critical write on the holder — journaled locally.
    const runner = await ctx.db.runner.findFirstOrThrow({
      where: { eventId: localEvent.id, cardNo: 800200 },
      select: { seq: true },
    });
    await leaseCaller.race.recordFinish({
      id: runner.seq,
      finishTimeAbsolute: 370000,
      status: 1,
    });

    // Barrier: with a dead transport, checkin must refuse.
    _setPeerTransportFactory(() => ({
      push: async () => ({ synced: [], failed: [{ id: "x", error: "offline" }] }),
      since: async () => ({
        entries: [],
        nextCursor: { hlc: "0", id: "" },
        hasMore: false,
      }),
    }));
    await expect(leaseCaller.lease.checkin()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    // Healthy link: ships, then releases on both nodes.
    _setPeerTransportFactory(() => transportToB());
    const res = await leaseCaller.lease.checkin();
    expect(res.ok).toBe(true);
    expect(res.pushed).toBeGreaterThanOrEqual(1);

    // The finish arrived on B (366000+4000 abs − 324000 zero = 46000 rel).
    const runnerB = await dbB.runner.findFirstOrThrow({
      where: { eventId: eventB.id, cardNo: 800200 },
    });
    expect(runnerB.finishTime).toBe(370000 - 324000);
    expect(runnerB.status).toBe("ok");

    expect(await getActiveLease(ctx.db, localEvent.id)).toBeNull();
    expect(await getActiveLease(dbB, eventB.id)).toBeNull();
  });

  it("re-checkout replaces the map rows and fetches no blob it already holds", async () => {
    const before = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash }, select: { createdAt: true } });
    const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    expect(res.maps).toMatchObject({ files: 1, sources: 1, documents: 1, fetchedBytes: 0, skipped: 1 });
    const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
    const files = await ctx.db.mapFile.findMany({ where: { eventId: local.id } });
    expect(files).toHaveLength(1);
    expect(files[0].sourceHash).toBe(sourceHash);
    const after = await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: documentHash }, select: { createdAt: true } });
    expect(after.createdAt).toEqual(before.createdAt);
    // The event's graphic again (the event's replacement cascaded it); the club graphic held with its hash is not fetched.
    expect(res.graphics).toEqual({ rows: 2, fetchedBytes: EVENT_SVG.length });
    expect(Buffer.from((await ctx.db.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } })).data).equals(EVENT_SVG)).toBe(true);
    await undoCheckout();
  });

  it("a local graphic in a travelling id's place is replaced by the cloud's", async () => {
    // A box-local club graphic under the club graphic's id, other bytes.
    await ctx.db.graphic.create({ data: { id: clubGraphicId, eventId: null, name: "local.png", mime: "image/png", data: EVENT_SVG, sizeBytes: EVENT_SVG.length } });
    try {
      const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME });
      expect(res.graphics).toEqual({ rows: 2, fetchedBytes: EVENT_SVG.length + CLUB_PNG.length });
      const club = await ctx.db.graphic.findUniqueOrThrow({ where: { id: clubGraphicId } });
      expect(club).toMatchObject({ eventId: null, name: `club-${mapSuffix}.png` });
      expect(Buffer.from(club.data).equals(CLUB_PNG)).toBe(true);
    } finally {
      await undoCheckout();
    }
  });
});

describe("forceTakeover", () => {
  it("releases a foreign lease with forced=true after explicit confirm", async () => {
    await acquireLease(ctx.db, ctx.eventId, "venue-dead");
    const res = await caller.lease.forceTakeover({ confirm: true });
    expect(res.ok).toBe(true);
    expect(res.takenFrom).toBe("venue-dead");
    expect(await getActiveLease(ctx.db, ctx.eventId)).toBeNull();
    const last = await ctx.db.eventLease.findFirst({
      where: { eventId: ctx.eventId },
      orderBy: { id: "desc" },
    });
    expect(last?.forced).toBe(true);
  });

  it("refuses when no lease is active", async () => {
    await expect(
      caller.lease.forceTakeover({ confirm: true }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("layout writes on a venue box are forwarded to the cloud (G18)", () => {
  /** A box: the forwarder in front of a stub tRPC route that records what ran locally. */
  async function venueBox(peerUrl: string) {
    const previous = { role: process.env.NODE_ROLE, peer: process.env.SYNC_PEER_URL };
    process.env.NODE_ROLE = "venue";
    process.env.SYNC_PEER_URL = peerUrl;
    const local: string[] = [];
    const box = Fastify({ logger: false });
    try {
      registerVenueForwarder(box);
    } finally {
      if (previous.role === undefined) delete process.env.NODE_ROLE;
      else process.env.NODE_ROLE = previous.role;
      process.env.SYNC_PEER_URL = previous.peer ?? PEER_URL;
    }
    box.post("/trpc/*", async (req) => {
      local.push(req.url);
      return { result: { data: "local" } };
    });
    await box.ready();
    return { box, local };
  }

  it("forwards sheet, layout and course-object writes with body, event and user; runs local writes locally", async () => {
    const seen: Array<{ url: string; body: unknown; event: unknown; user: unknown }> = [];
    const cloud = Fastify({ logger: false });
    cloud.post("/trpc/*", async (req) => {
      seen.push({ url: req.url, body: req.body, event: req.headers["x-event-id"], user: req.headers["x-forwarded-email"] });
      return req.url.includes("batch=1") ? [{ result: { data: "cloud" } }, { result: { data: "cloud" } }] : { result: { data: "cloud" } };
    });
    const address = await cloud.listen({ port: 0, host: "127.0.0.1" });
    const { box, local } = await venueBox(address);
    try {
      const headers = { "content-type": "application/json", "x-event-id": CHECKOUT_NAME, "x-forwarded-email": "setter@example.test" };
      const save = await box.inject({ method: "POST", url: "/trpc/courseMap.saveLayout", headers, payload: { seq: 1, objects: [] } });
      expect(save.statusCode).toBe(200);
      expect(save.json()).toEqual({ result: { data: "cloud" } });
      const batch = await box.inject({
        method: "POST",
        url: "/trpc/layout.autoSheets,courseObject.update?batch=1",
        headers,
        payload: { 0: { courseId: 1 }, 1: { id: 2, baseVersion: (2n ** 60n).toString() } },
      });
      expect(batch.statusCode).toBe(200);
      expect(seen).toEqual([
        { url: "/trpc/courseMap.saveLayout", body: { seq: 1, objects: [] }, event: CHECKOUT_NAME, user: "setter@example.test" },
        { url: "/trpc/layout.autoSheets,courseObject.update?batch=1", body: { 0: { courseId: 1 }, 1: { id: 2, baseVersion: (2n ** 60n).toString() } }, event: CHECKOUT_NAME, user: "setter@example.test" },
      ]);
      // Reads stay on the box; race-critical writes run there.
      const runner = await box.inject({ method: "POST", url: "/trpc/runner.update", headers, payload: {} });
      expect(runner.json()).toEqual({ result: { data: "local" } });
      expect(local).toEqual(["/trpc/runner.update"]);
    } finally {
      await box.close();
      await cloud.close();
    }
  });

  it("answers the typed 412 offline, and refuses a batch that mixes cloud-owned and local calls without running either", async () => {
    // A port nothing listens on: the cloud is unreachable.
    const probe = Fastify({ logger: false });
    const dead = await probe.listen({ port: 0, host: "127.0.0.1" });
    await probe.close();
    const { box, local } = await venueBox(dead);
    try {
      const headers = { "content-type": "application/json", "x-event-id": CHECKOUT_NAME };
      const offline = await box.inject({ method: "POST", url: "/trpc/mapTemplate.update", headers, payload: {} });
      expect(offline.statusCode).toBe(412);
      expect(offline.json()).toMatchObject({ error: { data: { code: "PRECONDITION_FAILED", reason: "CLOUD_UNREACHABLE", path: "mapTemplate.update" } } });
      const mixed = await box.inject({ method: "POST", url: "/trpc/course.presence,graphics.delete?batch=1", headers, payload: { 0: {}, 1: {} } });
      expect(mixed.statusCode).toBe(412);
      expect((mixed.json() as Array<{ error: { data: { reason: string } } }>).map((e) => e.error.data.reason)).toEqual(["MIXED_BATCH", "MIXED_BATCH"]);
      expect(local).toEqual([]);
    } finally {
      await box.close();
    }
  });
});
