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
 *
 * G19 (docs/map-storage.md §7.2 "Following the cloud during a lease"): a
 * box mirrors the cloud's sheets, templates, objects, graphics, class
 * print overrides, map files and patch on refresh — a sheet edited and a
 * map re-imported on the cloud reach it, offline it keeps its copy, and
 * nothing race-critical is touched.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { execSync } from "child_process";
import { Client } from "pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client.js";
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
  acquireLeaseForPeer,
  releaseLease,
  releaseLeaseForPeer,
  getActiveLease,
  assertRaceWritable,
  exportEventSnapshot,
  importEventSnapshot,
  schemaName,
  _setLeasePeerFactory,
  type LeasePeer,
} from "../../sync/lease.js";
import {
  _setPeerTransportFactory,
  refreshAllSettingsOnce,
  shipAllOnce,
  shipEventOnce,
  type PeerTransport,
} from "../../sync/shipper.js";
import { canonicalJson, exportMapRows, refreshCloudOwnedMaps, refreshWrites } from "../../sync/mapRefresh.js";
import { refreshCloudOwnedSettings } from "../../sync/settingsRefresh.js";
import {
  ingestJournalEntries,
  listJournalEntriesSince,
  listUnshippedJournalEntries,
  markJournalShipped,
  _resetDeliveryRefusalWarnings,
} from "../../routers/events.js";
import { nodeId } from "../../sync/nodeIdentity.js";
import type { EventRef } from "../../db.js";
import { importAndStoreOcad } from "../../map-store/documents.js";
import { exportBlobSlice } from "../../sync/snapshotMaps.js";
import { exportGraphicSlice, exportPeerBlobSlice } from "../../sync/snapshotGraphics.js";
import { refreshAfterForward, registerVenueForwarder } from "../../sync/venueForwarder.js";
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
      await acquireLeaseForPeer(dbB, eventB.id, holder);
    },
    release: async (_nameId, holder) => {
      await releaseLease(dbB, eventB.id, { expectedHolder: holder });
    },
    exportSnapshot: async () => exportEventSnapshot(dbB, eventB),
    holder: async () => ({ holderNodeId: (await getActiveLease(dbB, eventB.id))?.holderNodeId ?? null }),
    exportSettings: async () =>
      (await dbB.event.findUniqueOrThrow({
        where: { id: eventB.id },
      })) as unknown as Record<string, unknown>,
    exportBlob: async (_nameId, input) => exportPeerBlobSlice(dbB, eventB.id, input),
    exportMapRows: async () => exportMapRows(dbB, eventB.id),
  };
}

/** The same peer, its snapshot through a JSON round trip as over HTTP (BigInt → number). */
function jsonLeasePeerToB(): LeasePeer {
  return {
    ...leasePeerToB(),
    exportSnapshot: async () => JSON.parse(JSON.stringify(await exportEventSnapshot(dbB, eventB))),
    exportMapRows: async () => JSON.parse(JSON.stringify(await exportMapRows(dbB, eventB.id))),
  };
}

function transportToB(): PeerTransport {
  return {
    // As `events.push` on the node-secret path: the entries are from the peer.
    push: (_nameId, entries) => ingestJournalEntries(dbB, eventB, entries, { fromPeer: true }),
    unshipped: (_nameId, limit) => listUnshippedJournalEntries(dbB, eventB, limit),
    ack: async (_nameId, ids) => {
      await markJournalShipped(dbB, eventB.id, ids);
    },
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
      unshipped: async () => ({ entries: [], hasMore: false }),
      ack: async () => {},
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

  it("a runner created on the venue ships to the cloud, and the cloud's next create takes the next seq (DB-01)", async () => {
    await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    const local = await ctx.db.event.findUniqueOrThrow({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true, nameId: true, zeroTime: true },
    });
    const venue = makeCaller({ id: local.id, nameId: local.nameId, zeroTime: local.zeroTime });
    const cls = await ctx.db.class.findFirstOrThrow({ where: { eventId: local.id }, select: { seq: true } });
    await venue.runner.create({ name: "Venue Vera", classId: cls.seq, cardNo: 800301 });
    const created = await ctx.db.runner.findFirstOrThrow({ where: { eventId: local.id, cardNo: 800301 } });
    expect((await venue.lease.checkin()).ok).toBe(true);

    const onB = await dbB.runner.findFirstOrThrow({ where: { eventId: eventB.id, cardNo: 800301 } });
    expect(onB.seq).toBe(created.seq);
    // Back on the cloud (B), a plain create continues past the shipped seq.
    const next = await dbB.runner.create({
      data: { eventId: eventB.id, name: "Cloud Clara", cardNo: 800302 },
    });
    expect(next.seq).toBeGreaterThan(created.seq);
  });

  it("a re-checkout after that checkin accepts a venue create again (DB-01)", async () => {
    await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    const local = await ctx.db.event.findUniqueOrThrow({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true, nameId: true, zeroTime: true },
    });
    const venue = makeCaller({ id: local.id, nameId: local.nameId, zeroTime: local.zeroTime });
    const cls = await ctx.db.class.findFirstOrThrow({ where: { eventId: local.id }, select: { seq: true } });
    await venue.runner.create({ name: "Venue Ville", classId: cls.seq, cardNo: 800303 });
    const rows = await ctx.db.runner.findMany({ where: { eventId: local.id }, select: { seq: true } });
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
    expect((await venue.lease.checkin()).ok).toBe(true);
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

  it("an entry committed on the cloud between acquire and export reaches the box exactly once (MC-22)", async () => {
    const wire = (code: number, id = randomUUID()) => ({
      id,
      type: "punch.recorded" as const,
      competitionId: CHECKOUT_NAME,
      stationId: "roc-mc22",
      timestamp: Date.now(),
      hlc: { physical: Date.now(), logical: 0 },
      schemaVersion: 1,
      payload: { cardNo: 800200, controlCode: code, time: 372000 + code, origin: "online_input" },
    });
    // History before the checkout: baked into the snapshot, never pulled.
    const before = wire(61);
    await ingestJournalEntries(dbB, eventB, [before]);
    // Lands on the cloud after the lease is taken, before the snapshot is read.
    const during = wire(62);
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      exportSnapshot: async () => {
        await ingestJournalEntries(dbB, eventB, [during]);
        return exportEventSnapshot(dbB, eventB);
      },
    }));
    try {
      await caller.lease.checkout({ nameId: CHECKOUT_NAME });
      const local = await ctx.db.event.findUniqueOrThrow({
        where: { nameId: CHECKOUT_NAME },
        select: { id: true, nameId: true, zeroTime: true },
      });
      expect((await dbB.journalEntry.findUniqueOrThrow({ where: { id: before.id } })).pushedAt).not.toBeNull();
      expect((await dbB.journalEntry.findUniqueOrThrow({ where: { id: during.id } })).pushedAt).toBeNull();

      const stats = await shipEventOnce(ctx.db, local, PEER_URL, transportToB());
      expect(stats.errors).toEqual([]);
      expect(stats.pulled).toBe(1);
      expect(await ctx.db.journalEntry.findUnique({ where: { id: before.id } })).toBeNull();
      expect(await ctx.db.journalEntry.findUnique({ where: { id: during.id } })).not.toBeNull();
      const punches = await ctx.db.punch.findMany({
        where: { eventId: local.id, cardNo: 800200, controlCode: { in: [61, 62] } },
      });
      expect(punches.map((p) => p.controlCode).sort()).toEqual([61, 62]);
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
      await undoCheckout();
    }
  });

describe("checkout guard and restart safety (API-07, SYNC-18)", () => {
  const deadTransport = (): PeerTransport => ({
    push: async () => ({ synced: [], failed: [{ id: "x", error: "offline" }] }),
    unshipped: async () => ({ entries: [], hasMore: false }),
    ack: async () => {},
  });

  async function checkedOutVenue() {
    await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    const local = await ctx.db.event.findUniqueOrThrow({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true, nameId: true, zeroTime: true },
    });
    return { local, venue: makeCaller({ id: local.id, nameId: local.nameId, zeroTime: local.zeroTime }) };
  }

  let writeSeq = 0;
  /** A race-entry the venue journals (a new runner), unique per call. */
  async function venueWrite(venue: ReturnType<typeof makeCaller>, localId: bigint) {
    const cls = await ctx.db.class.findFirstOrThrow({ where: { eventId: localId }, select: { seq: true } });
    await venue.runner.create({ name: `Guard ${writeSeq}`, classId: cls.seq, cardNo: 8_100_000 + writeSeq++ });
  }

  /** The venue loses the box's lease on both sides without shipping (the failure a re-checkout must not paper over). */
  async function dropLeasesWithoutShipping(localId: bigint) {
    await releaseLease(ctx.db, localId, { forced: true });
    await releaseLease(dbB, eventB.id, { forced: true });
  }

  afterAll(async () => {
    _setPeerTransportFactory(() => transportToB());
    _setLeasePeerFactory(() => leasePeerToB());
  });

  it("refuses a checkout while this box still holds the lease", async () => {
    await checkedOutVenue();
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringMatching(/^CHECKOUT_LEASE_HELD/),
      });
    } finally {
      await undoCheckout();
    }
  });

  it("a re-checkout with unshipped entries and no link is refused; nothing is touched; discardLocal overrides", async () => {
    const { local, venue } = await checkedOutVenue();
    await venueWrite(venue, local.id);
    await dropLeasesWithoutShipping(local.id);
    const journalBefore = await ctx.db.journalEntry.count({ where: { eventId: local.id } });

    _setPeerTransportFactory(() => deadTransport());
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringMatching(/^CHECKOUT_UNSHIPPED: \d+ journal entries/),
      });
      expect(await ctx.db.journalEntry.count({ where: { eventId: local.id } })).toBe(journalBefore);
      expect(await getActiveLease(dbB, eventB.id)).toBeNull();
      expect((await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME } })).id).toBe(local.id);

      const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME, discardLocal: true });
      expect(res.ok).toBe(true);
      expect((await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME } })).id).not.toBe(local.id);
    } finally {
      _setPeerTransportFactory(() => transportToB());
      await undoCheckout();
    }
  });

  it("a re-checkout ships what it can first: entries that reach the cloud do not block it", async () => {
    const { local, venue } = await checkedOutVenue();
    await venueWrite(venue, local.id);
    await dropLeasesWithoutShipping(local.id);
    try {
      expect((await caller.lease.checkout({ nameId: CHECKOUT_NAME })).ok).toBe(true);
      expect(await dbB.runner.count({ where: { eventId: eventB.id, name: { startsWith: "Guard " } } })).toBeGreaterThan(0);
    } finally {
      await undoCheckout();
    }
  });

  it("an event created on this box is not replaced unless discardLocal", async () => {
    await ctx.db.event.deleteMany({ where: { nameId: CHECKOUT_NAME } });
    await ctx.db.event.create({
      data: { nameId: CHECKOUT_NAME, name: "Box-made", date: new Date("2026-01-01T00:00:00Z"), kind: "competition" },
    });
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({
        message: expect.stringMatching(/^CHECKOUT_LOCAL_EVENT/),
      });
      expect(await getActiveLease(dbB, eventB.id)).toBeNull();
      expect((await caller.lease.checkout({ nameId: CHECKOUT_NAME, discardLocal: true })).ok).toBe(true);
    } finally {
      await undoCheckout();
    }
  });

  it("with auth on, a checkout needs an admin for a new event and event.manage for an existing one", async () => {
    const row = await ctx.db.user.create({
      data: { email: `stranger-${mapSuffix}@lease.example`, displayName: "Stranger", active: true },
    });
    const stranger = { id: row.id, email: row.email, displayName: "Stranger", isAdmin: false, active: true };
    const authed = makeCaller(null, { authEnabled: true, authMode: "dev", user: stranger });
    await expect(authed.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = makeCaller(null, { authEnabled: true, authMode: "dev", user: { ...stranger, isAdmin: true } });
    try {
      expect((await admin.lease.checkout({ nameId: CHECKOUT_NAME })).ok).toBe(true);
      await dropLeasesWithoutShipping((await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME } })).id);
      await expect(authed.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await undoCheckout();
      await ctx.db.user.delete({ where: { id: row.id } }).catch(() => {});
    }
  });

  it("readout backups survive a re-checkout", async () => {
    const { local } = await checkedOutVenue();
    await ctx.db.cardReadoutBackup.create({
      data: {
        eventId: local.id,
        slotAddress: 4,
        cardNo: 8_000_001,
        punches: [{ controlCode: 31, time: 1000 }],
        punchesHash: `bk-${mapSuffix}`,
        ownerData: Prisma.DbNull,
      },
    });
    await ctx.db.journalEntry.updateMany({ where: { eventId: local.id }, data: { pushedAt: new Date() } });
    await dropLeasesWithoutShipping(local.id);
    try {
      await caller.lease.checkout({ nameId: CHECKOUT_NAME });
      const now = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
      const kept = await ctx.db.cardReadoutBackup.findMany({ where: { eventId: now.id } });
      expect(kept.map((b) => b.cardNo)).toEqual([8_000_001]);
    } finally {
      await undoCheckout();
    }
  });

  it("acquiring twice as the same holder returns the same lease; another holder still conflicts", async () => {
    const first = await acquireLease(ctx.db, ctx.eventId, "venue-twice");
    try {
      const again = await acquireLease(ctx.db, ctx.eventId, "venue-twice");
      expect(again.id).toBe(first.id);
      await expect(acquireLease(ctx.db, ctx.eventId, "venue-other")).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await releaseLease(ctx.db, ctx.eventId);
    }
  });

  it("peer release is idempotent for the holder that already released", async () => {
    await acquireLease(ctx.db, ctx.eventId, "venue-idem");
    await releaseLeaseForPeer(ctx.db, ctx.eventId, "venue-idem");
    await releaseLeaseForPeer(ctx.db, ctx.eventId, "venue-idem");
    await expect(releaseLeaseForPeer(ctx.db, ctx.eventId, "venue-nobody")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("a checkout that dies after the peer took the lease (export throws, release also fails) can simply be retried", async () => {
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      exportSnapshot: async () => {
        throw new Error("link dropped");
      },
      release: async () => {
        throw new Error("link still down");
      },
    }));
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toThrow("link dropped");
      expect((await getActiveLease(dbB, eventB.id))?.holderNodeId).toBe("cloud"); // stranded on the peer
      expect(await ctx.db.event.findUnique({ where: { nameId: CHECKOUT_NAME } })).toBeNull();
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
    }
    try {
      expect((await caller.lease.checkout({ nameId: CHECKOUT_NAME })).ok).toBe(true);
    } finally {
      await undoCheckout();
    }
  });

  it("a clear refusal of the acquire (NOT_FOUND) is not rolled back: no release is sent, no alarming log", async () => {
    const release = vi.fn(async () => {});
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      acquire: async () => {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      },
      release,
    }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(release).not.toHaveBeenCalled();
      expect(err.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("could not be released"))).toEqual([]);
    } finally {
      err.mockRestore();
      _setLeasePeerFactory(() => leasePeerToB());
    }
  });

  it("an acquire whose reply is lost is rolled back, not left holding", async () => {
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      acquire: async (nameId, holder) => {
        await leasePeerToB().acquire(nameId, holder);
        throw new Error("reply lost");
      },
    }));
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toThrow("reply lost");
      expect(await getActiveLease(dbB, eventB.id)).toBeNull();
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
    }
  });

  it("a failing afterImport rolls the whole import back: the existing local event is untouched", async () => {
    const { local } = await checkedOutVenue();
    await dropLeasesWithoutShipping(local.id);
    const snapshot = await exportEventSnapshot(dbB, eventB);
    const runnersBefore = await ctx.db.runner.count({ where: { eventId: local.id } });
    try {
      await expect(
        importEventSnapshot(ctx.db, snapshot, undefined, undefined, {
          afterImport: async () => {
            throw new Error("boom after import");
          },
        }),
      ).rejects.toThrow("boom after import");
      const still = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
      expect(still.id).toBe(local.id);
      expect(await ctx.db.runner.count({ where: { eventId: local.id } })).toBe(runnersBefore);
    } finally {
      await undoCheckout();
    }
  });

  it("checkin whose peer release reply was lost: the retry succeeds", async () => {
    const { local, venue } = await checkedOutVenue();
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      release: async (nameId, holder) => {
        await leasePeerToB().release(nameId, holder);
        throw new Error("reply lost");
      },
    }));
    try {
      await expect(venue.lease.checkin()).rejects.toThrow("reply lost");
      expect(await getActiveLease(dbB, eventB.id)).toBeNull();
      expect((await getActiveLease(ctx.db, local.id))?.holderNodeId).toBe("cloud");
      _setLeasePeerFactory(() => leasePeerToB());
      expect((await venue.lease.checkin()).ok).toBe(true);
      expect(await getActiveLease(ctx.db, local.id)).toBeNull();
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
      await undoCheckout();
    }
  });

  it("checkin when the peer says the lease is held by another node releases locally and reports it", async () => {
    const { local, venue } = await checkedOutVenue();
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      release: async () => {
        throw new TRPCError({ code: "CONFLICT", message: 'Lease is held by "someone-else", not "cloud".' });
      },
    }));
    try {
      const res = await venue.lease.checkin();
      expect(res).toMatchObject({ ok: true, peerAlreadyReleased: true });
      expect(await getActiveLease(ctx.db, local.id)).toBeNull();
      expect((await ctx.db.eventLease.findFirstOrThrow({ where: { eventId: local.id }, orderBy: { id: "desc" } })).forced).toBe(true);
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
      await undoCheckout();
    }
  });

  it("race writes are refused on the box while its checkin barrier runs, and are guarded again by the lease afterwards", async () => {
    const { local, venue } = await checkedOutVenue();
    let during: unknown = "not run";
    _setPeerTransportFactory(() => ({
      ...transportToB(),
      push: async (n, entries) => {
        during = await assertRaceWritable(ctx.db, local.id).then(() => "writable", (e: TRPCError) => e.code);
        return transportToB().push(n, entries);
      },
    }));
    try {
      await venueWrite(venue, local.id);
      expect((await venue.lease.checkin()).ok).toBe(true);
      expect(during).toBe("PRECONDITION_FAILED");
      await assertRaceWritable(ctx.db, local.id); // the barrier is over and no lease remains
    } finally {
      _setPeerTransportFactory(() => transportToB());
      await undoCheckout();
    }
  });
});

describe("a graphic id another event owns (D10, MC-32)", () => {
  const OTHER_BYTES = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 3"><!--other-${mapSuffix}--></svg>`);
  const plantOtherEventsGraphic = () =>
    ctx.db.graphic.create({
      data: { id: eventGraphicId, eventId: ctx.eventId, name: "other.svg", mime: "image/svg+xml", data: OTHER_BYTES, sizeBytes: OTHER_BYTES.length },
    });
  const removePlanted = () => ctx.db.graphic.deleteMany({ where: { id: eventGraphicId, eventId: ctx.eventId } });

  it("refuses the checkout, keeps the other event's bytes, frees the peer lease and writes nothing", async () => {
    await plantOtherEventsGraphic();
    try {
      await expect(caller.lease.checkout({ nameId: CHECKOUT_NAME })).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(new RegExp(`^GRAPHIC_ID_CLASH: graphic ${eventGraphicId} on this box belongs to "Test Event lease`)),
      });
      const row = await ctx.db.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } });
      expect(row.eventId).toBe(ctx.eventId);
      expect(Buffer.from(row.data).equals(OTHER_BYTES)).toBe(true);
      expect(await getActiveLease(dbB, eventB.id)).toBeNull();
      expect(await ctx.db.event.findUnique({ where: { nameId: CHECKOUT_NAME } })).toBeNull();
    } finally {
      await removePlanted();
    }
  });

  it("replaceClashingGraphics: true replaces it, as G18 says", async () => {
    await plantOtherEventsGraphic();
    try {
      const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME, replaceClashingGraphics: true });
      expect(res.ok).toBe(true);
      const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
      const row = await ctx.db.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } });
      expect(row.eventId).toBe(local.id);
      expect(Buffer.from(row.data).equals(EVENT_SVG)).toBe(true);
    } finally {
      await undoCheckout();
      await removePlanted();
    }
  });

  it("a re-checkout over its own copy of the graphic is no clash", async () => {
    await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
    await releaseLease(ctx.db, local.id, { forced: true });
    await releaseLease(dbB, eventB.id, { forced: true });
    await ctx.db.journalEntry.updateMany({ where: { eventId: local.id }, data: { pushedAt: new Date() } });
    try {
      expect((await caller.lease.checkout({ nameId: CHECKOUT_NAME })).ok).toBe(true);
    } finally {
      await undoCheckout();
    }
  });

  it("the import itself refuses when the flag is not set (the lease-time refresh never sets it)", async () => {
    await plantOtherEventsGraphic();
    try {
      const snapshot = await exportEventSnapshot(dbB, eventB);
      const bytes = new Map(snapshot.graphics!.map((g) => [g.id, g.id === String(eventGraphicId) ? EVENT_SVG : CLUB_PNG]));
      await expect(
        importEventSnapshot(ctx.db, snapshot, undefined, { bytes, fetchedBytes: 0 }),
      ).rejects.toMatchObject({ message: expect.stringMatching(/^GRAPHIC_ID_CLASH/) });
      expect(await ctx.db.event.findUnique({ where: { nameId: CHECKOUT_NAME } })).toBeNull();
    } finally {
      await removePlanted();
    }
  });
});
});

describe("a box follows the cloud's map rows during a lease (G19)", () => {
  // docs/map-storage.md §7.2 "Following the cloud during a lease".
  const SHEET_VERSION_2 = SHEET_VERSION + 1n; // rounds like SHEET_VERSION over JSON
  const TEMPLATE_VERSION_2 = TEMPLATE_VERSION + 1n;
  const NEW_SHEET_VERSION = 2n ** 60n + 404n;
  const NEW_SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!--new-${mapSuffix}--></svg>`);
  let box: EventRef;
  let reimport: { sourceHash: string; documentHash: string; bytes: Buffer };
  const cleanup: Array<() => Promise<unknown>> = [];

  const refresh = (peer: LeasePeer = jsonLeasePeerToB()) => refreshCloudOwnedMaps(ctx.db, box, peer);
  const sheetOnB = () => dbB.courseMap.findUniqueOrThrow({ where: { id: sheetBId } });
  const sheetOnBox = () => ctx.db.courseMap.findUniqueOrThrow({ where: { id: sheetBId } });
  const boxFiles = () => ctx.db.mapFile.findMany({ where: { eventId: box.id } });

  /** Every race-critical row of the box's event, less the classes' two cloud-owned layout columns. */
  async function raceDigest(): Promise<string> {
    const eventId = box.id;
    const db = ctx.db;
    const parts: unknown[][] = await Promise.all([
      db.control.findMany({ where: { eventId } }),
      db.course.findMany({ where: { eventId } }),
      db.courseControl.findMany({ where: { course: { eventId } } }),
      db.class.findMany({ where: { eventId }, omit: { printScale: true, sheetTemplateId: true, updatedAt: true } }),
      db.classCoursePool.findMany({ where: { class: { eventId } } }),
      db.runner.findMany({ where: { eventId } }),
      db.team.findMany({ where: { eventId } }),
      db.card.findMany({ where: { eventId } }),
      db.cardReadout.findMany({ where: { eventId } }),
      db.punch.findMany({ where: { eventId } }),
      db.controlUnit.findMany({ where: { eventId } }),
      db.journalEntry.findMany({ where: { eventId } }),
      db.journalSyncState.findMany({ where: { eventId } }),
      db.eventSeq.findMany({ where: { eventId, tableName: { notIn: ["map_templates", "course_maps", "course_objects"] } } }),
      db.event.findMany({ where: { id: eventId }, select: { zeroTime: true, date: true, finishReceiptMessage: true } }),
    ]);
    return parts.map((rows) => rows.map(canonicalJson).sort().join("\n")).join("\n--\n");
  }

  beforeAll(async () => {
    _setLeasePeerFactory(() => jsonLeasePeerToB());
    try {
      await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
    }
    box = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true, nameId: true, zeroTime: true } });
    const bytes = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`lease-reimport-${mapSuffix}`)]);
    const stored = await importAndStoreOcad(dbB, bytes, "lease2.ocd");
    reimport = { sourceHash: stored.sourceHash, documentHash: stored.documentHash, bytes };
  }, 60_000);

  afterAll(async () => {
    for (const undo of cleanup.reverse()) await undo();
    await undoCheckout();
    for (const db of [ctx.db, dbB] as const) {
      await db.mapDocument.deleteMany({ where: { sourceHash: reimport.sourceHash } });
      await db.mapSource.deleteMany({ where: { fileHash: reimport.sourceHash } });
    }
  }, 60_000);

  it("an unchanged cloud: nothing written, nothing fetched", async () => {
    const before = { sheet: await sheetOnBox(), files: await boxFiles() };
    const res = await refresh();
    expect(res).not.toBeNull();
    expect(refreshWrites(res!)).toBe(0);
    expect(res!.fetchedBytes).toBe(0);
    expect((await sheetOnBox()).updatedAt).toEqual(before.sheet.updatedAt);
    expect((await boxFiles()).map((f) => f.id)).toEqual(before.files.map((f) => f.id));
  });

  it("does nothing on a node that is not the holder, and asks the cloud nothing", async () => {
    let asked = false;
    const peer: LeasePeer = {
      ...leasePeerToB(),
      exportMapRows: async () => {
        asked = true;
        return exportMapRows(dbB, eventB.id);
      },
    };
    expect(await refreshCloudOwnedMaps(ctx.db, ctx.event, peer)).toBeNull();
    expect(asked).toBe(false);
  });

  it("lease.exportMapRows answers behind the shared secret", async () => {
    await expect(makeCaller(box).lease.exportMapRows()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rows = await makeCaller(box, { syncSecret: "test-sync-secret" }).lease.exportMapRows();
    expect(rows.maps.files).toHaveLength(1);
    expect(rows.maps.decisions).toBeUndefined();
    expect(rows.tables.courseMap.map((r) => r.id)).toEqual([sheetBId]);
    expect(rows.versions.courseMap).toEqual({ [sheetBId]: SHEET_VERSION.toString() });
    expect(rows.classOverrides).toEqual([expect.objectContaining({ printScale: 7500, sheetTemplateId: templateBId })]);
    expect(rows.graphics?.map((g) => g.id)).toEqual([eventGraphicId, clubGraphicId].sort((a, b) => Number(a - b)).map(String));
  });

  it("layout edited on the cloud reaches the box at the next refresh, tokens exact, nothing race-critical touched", async () => {
    const digest = await raceDigest();
    const sheetBefore = await sheetOnB();
    const objectBefore = await dbB.courseObject.findUniqueOrThrow({ where: { id: objectBId } });
    const classB = await dbB.class.findFirstOrThrow({ where: { eventId: eventB.id, sheetTemplateId: templateBId } });
    const courseB = await dbB.course.findFirstOrThrow({ where: { eventId: eventB.id } });
    // On the cloud: a sheet edited, a template renamed, an object reordered
    // (z without a token), a class print scale changed, a sheet created
    // drawing a club graphic nothing drew before, an event graphic uploaded,
    // and a sheet for a course the box does not have.
    await dbB.courseMap.update({ where: { id: sheetBId }, data: { overrides: { scale: 7500 }, version: SHEET_VERSION_2 } });
    await dbB.mapTemplate.update({ where: { id: templateBId }, data: { name: "A4 liggande", version: TEMPLATE_VERSION_2 } });
    await dbB.courseObject.update({ where: { id: objectBId }, data: { z: objectBefore.z + 5 } });
    await dbB.class.update({ where: { id: classB.id }, data: { printScale: 5000 } });
    const newSheet = await dbB.courseMap.create({
      data: {
        eventId: eventB.id,
        name: "Extra",
        courseId: courseB.id,
        objects: [{ id: "img", anchor: "page", kind: "image", graphicId: Number(unreferencedClubGraphicId), x: 0, y: 0, width: 5, height: 5 }],
        version: NEW_SHEET_VERSION,
      },
    });
    const newGraphic = await dbB.graphic.create({ data: { eventId: eventB.id, name: "new.svg", mime: "image/svg+xml", data: NEW_SVG, sizeBytes: NEW_SVG.length } });
    const strayCourse = await dbB.course.create({ data: { eventId: eventB.id, name: "Only on the cloud" } });
    const straySheet = await dbB.courseMap.create({ data: { eventId: eventB.id, name: "Stray", courseId: strayCourse.id } });
    cleanup.push(async () => {
      await dbB.courseMap.update({ where: { id: sheetBId }, data: { overrides: sheetBefore.overrides as object, version: SHEET_VERSION } });
      await dbB.mapTemplate.update({ where: { id: templateBId }, data: { name: "A4", version: TEMPLATE_VERSION } });
      await dbB.courseObject.update({ where: { id: objectBId }, data: { z: objectBefore.z } });
      await dbB.class.update({ where: { id: classB.id }, data: { printScale: 7500 } });
      await dbB.courseMap.deleteMany({ where: { id: { in: [newSheet.id, straySheet.id] } } });
      await dbB.course.deleteMany({ where: { id: strayCourse.id } });
      await dbB.graphic.deleteMany({ where: { id: newGraphic.id } });
    });

    const res = await refresh();
    expect(res).toMatchObject({
      templates: { created: 0, updated: 1, deleted: 0 },
      classes: 1,
      sheets: { created: 1, updated: 1, deleted: 0, skipped: 1 },
      objects: { created: 0, updated: 1, deleted: 0 },
      graphics: { written: 2, updated: 0, deleted: 0 },
      fetchedBytes: NEW_SVG.length + CLUB_PNG.length,
      mapFiles: 0,
      patch: "unchanged",
    });

    const sheet = await sheetOnBox();
    expect(sheet.overrides).toEqual({ scale: 7500 });
    expect(sheet.version).toBe(SHEET_VERSION_2);
    expect(await ctx.db.mapTemplate.findUniqueOrThrow({ where: { id: templateBId } })).toMatchObject({ name: "A4 liggande", version: TEMPLATE_VERSION_2 });
    expect((await ctx.db.courseObject.findUniqueOrThrow({ where: { id: objectBId } })).z).toBe(objectBefore.z + 5);
    expect(await ctx.db.class.findUniqueOrThrow({ where: { id: classB.id } })).toMatchObject({ printScale: 5000, sheetTemplateId: templateBId });
    expect(await ctx.db.courseMap.findUnique({ where: { id: newSheet.id } })).toMatchObject({ seq: newSheet.seq, version: NEW_SHEET_VERSION });
    expect(await ctx.db.courseMap.findUnique({ where: { id: straySheet.id } })).toBeNull();
    expect(Buffer.from((await ctx.db.graphic.findUniqueOrThrow({ where: { id: newGraphic.id } })).data).equals(NEW_SVG)).toBe(true);
    expect(await ctx.db.graphic.findUniqueOrThrow({ where: { id: unreferencedClubGraphicId } })).toMatchObject({ eventId: null });
    // A sheet the box creates later takes a seq past the cloud's.
    const counter = await ctx.db.eventSeq.findUniqueOrThrow({ where: { eventId_tableName: { eventId: box.id, tableName: "course_maps" } } });
    expect(counter.nextSeq).toBeGreaterThan(newSheet.seq);
    expect(counter.nextSeq).toBeGreaterThan(straySheet.seq); // a skipped sheet's seq is reserved too
    // Nothing race-critical moved.
    expect(await raceDigest()).toBe(digest);

    // A second refresh: nothing to write, nothing to fetch.
    const again = await refresh();
    expect(refreshWrites(again!)).toBe(0);
    expect(again!.fetchedBytes).toBe(0);
    expect(again!.sheets.skipped).toBe(1);
  });

  it("rows deleted on the cloud are deleted on the box; a club graphic stays", async () => {
    const extra = await dbB.courseMap.findFirstOrThrow({ where: { eventId: eventB.id, name: "Extra" } });
    const newGraphic = await dbB.graphic.findFirstOrThrow({ where: { eventId: eventB.id, name: "new.svg" } });
    await dbB.courseMap.delete({ where: { id: extra.id } });
    await dbB.graphic.delete({ where: { id: newGraphic.id } });
    const res = await refresh();
    expect(res).toMatchObject({ sheets: { deleted: 1 }, graphics: { deleted: 1 } });
    expect(await ctx.db.courseMap.findUnique({ where: { id: extra.id } })).toBeNull();
    expect(await ctx.db.graphic.findUnique({ where: { id: newGraphic.id } })).toBeNull();
    expect(await ctx.db.graphic.findUnique({ where: { id: unreferencedClubGraphicId } })).not.toBeNull();
  });

  it("templates: a key change that promotes an extra and a name swap apply in any seq order; a delete nulls the box's references", async () => {
    const KEY = `k-${mapSuffix}`;
    // On the cloud: extra X (lower seq) and auto Y of one key.
    const x = await dbB.mapTemplate.create({ data: { eventId: eventB.id, name: `Swap1-${mapSuffix}`, printScale: 10000, autoKey: KEY, isExtra: true } });
    const y = await dbB.mapTemplate.create({ data: { eventId: eventB.id, name: `Swap2-${mapSuffix}`, printScale: 15000, autoKey: KEY, isExtra: false } });
    const courseOnB = await dbB.course.findFirstOrThrow({ where: { eventId: eventB.id, name: "Blå" } });
    const sheetOnX = await dbB.courseMap.create({ data: { eventId: eventB.id, name: "On X", courseId: courseOnB.id, templateId: x.id } });
    cleanup.push(async () => {
      await dbB.courseMap.deleteMany({ where: { id: sheetOnX.id } });
      await dbB.mapTemplate.deleteMany({ where: { id: { in: [x.id, y.id] } } });
    });
    expect(x.seq).toBeLessThan(y.seq);
    await refresh();
    expect(await ctx.db.mapTemplate.findUniqueOrThrow({ where: { id: y.id } })).toMatchObject({ autoKey: KEY, isExtra: false });

    // One cloud edit moves Y to another key and promotes X; the names swap too.
    await dbB.mapTemplate.update({ where: { id: y.id }, data: { name: `tmp-${mapSuffix}`, autoKey: `${KEY}-other` } });
    await dbB.mapTemplate.update({ where: { id: x.id }, data: { name: `Swap2-${mapSuffix}`, isExtra: false } });
    await dbB.mapTemplate.update({ where: { id: y.id }, data: { name: `Swap1-${mapSuffix}` } });
    const res = await refresh();
    expect(res!.templates).toEqual({ created: 0, updated: 2, deleted: 0 });
    expect(await ctx.db.mapTemplate.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({ name: `Swap2-${mapSuffix}`, autoKey: KEY, isExtra: false });
    expect(await ctx.db.mapTemplate.findUniqueOrThrow({ where: { id: y.id } })).toMatchObject({ name: `Swap1-${mapSuffix}`, autoKey: `${KEY}-other`, isExtra: false });

    // A template deleted on the cloud: gone on the box, the sheet that used it on NULL.
    await dbB.mapTemplate.delete({ where: { id: x.id } });
    const del = await refresh();
    expect(del!.templates.deleted).toBe(1);
    expect(await ctx.db.mapTemplate.findUnique({ where: { id: x.id } })).toBeNull();
    expect((await ctx.db.courseMap.findUniqueOrThrow({ where: { id: sheetOnX.id } })).templateId).toBeNull();
  });

  it("graphics: a rename on the cloud updates the box, new bytes under the same id are fetched", async () => {
    const original = await dbB.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } });
    cleanup.push(() => dbB.graphic.update({ where: { id: eventGraphicId }, data: { name: original.name, data: original.data, sizeBytes: original.sizeBytes } }));
    await dbB.graphic.update({ where: { id: eventGraphicId }, data: { name: "renamed.svg" } });
    const renamed = await refresh();
    expect(renamed).toMatchObject({ graphics: { written: 0, updated: 1, deleted: 0 }, fetchedBytes: 0 });
    expect((await ctx.db.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } })).name).toBe("renamed.svg");
    await dbB.graphic.update({ where: { id: eventGraphicId }, data: { data: NEW_SVG, sizeBytes: NEW_SVG.length } });
    const replaced = await refresh();
    expect(replaced).toMatchObject({ graphics: { written: 1 }, fetchedBytes: NEW_SVG.length });
    expect(Buffer.from((await ctx.db.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } })).data).equals(NEW_SVG)).toBe(true);
    await dbB.graphic.update({ where: { id: eventGraphicId }, data: { name: original.name, data: original.data, sizeBytes: original.sizeBytes } });
    await refresh();
  });

  it("a graphic id another event on the box owns is skipped with a warning; the rest of the refresh still applies (D10, MC-32)", async () => {
    const other = await createTestEvent("lease_clash");
    const originalB = await dbB.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } });
    const sheetBefore = await sheetOnB();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // On the box the id belongs to another event; on the cloud its bytes and a sheet change.
    await ctx.db.graphic.update({ where: { id: eventGraphicId }, data: { eventId: other.eventId } });
    const otherBytes = Buffer.from((await ctx.db.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } })).data);
    try {
      await dbB.graphic.update({ where: { id: eventGraphicId }, data: { data: NEW_SVG, sizeBytes: NEW_SVG.length } });
      await dbB.courseMap.update({ where: { id: sheetBId }, data: { overrides: { scale: 6100 }, version: SHEET_VERSION_2 } });
      const res = await refresh();
      expect(res).not.toBeNull();
      // The clashing graphic's bytes are not even fetched.
      expect(res!.fetchedBytes).toBe(0);
      expect((await sheetOnBox()).overrides).toEqual({ scale: 6100 });
      await refresh();
      // One warning per graphic per process, not one per cycle.
      expect(warn.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("graphic clash"))).toHaveLength(1);
      const row = await ctx.db.graphic.findUniqueOrThrow({ where: { id: eventGraphicId } });
      expect(row.eventId).toBe(other.eventId);
      expect(Buffer.from(row.data).equals(otherBytes)).toBe(true);
      expect(warn.mock.calls.map((c) => c.join(" ")).some((m) => m.includes("GRAPHIC_ID_CLASH") || m.includes("graphic clash"))).toBe(true);
    } finally {
      warn.mockRestore();
      await ctx.db.graphic.update({ where: { id: eventGraphicId }, data: { eventId: box.id } });
      await dbB.graphic.update({ where: { id: eventGraphicId }, data: { name: originalB.name, data: originalB.data, sizeBytes: originalB.sizeBytes } });
      await dbB.courseMap.update({ where: { id: sheetBId }, data: { overrides: sheetBefore.overrides as Prisma.InputJsonValue, version: sheetBefore.version } });
      await refresh();
      await other.cleanup();
    }
  });

  it("the mirror is exact: a course object and a map file the box wrote itself go at the next refresh", async () => {
    const local = await ctx.db.courseObject.create({
      data: { eventId: box.id, kind: "text", geometry: [{ x: 0, y: 0 }], props: { text: "box" }, scope: { all: true }, source: "import" },
    });
    // A box-local object takes a seq past the cloud's.
    const cloudMax = (await dbB.courseObject.aggregate({ where: { eventId: eventB.id }, _max: { seq: true } }))._max.seq ?? 0;
    expect(local.seq).toBeGreaterThan(cloudMax);
    await ctx.db.mapFile.create({ data: { eventId: box.id, fileName: "box-upload.ocd", sourceHash, documentHash } });
    const res = await refresh();
    expect(res).toMatchObject({ objects: { deleted: 1 }, mapFiles: 3 });
    expect(await ctx.db.courseObject.findUnique({ where: { id: local.id } })).toBeNull();
    expect((await boxFiles()).map((f) => f.fileName)).toEqual(["lease.ocd"]);
  });

  it("two refreshes of one event at once both settle, the second after the first", async () => {
    await dbB.courseMap.update({ where: { id: sheetBId }, data: { name: "Concurrent" } });
    cleanup.push(() => dbB.courseMap.update({ where: { id: sheetBId }, data: { name: "Blå karta" } }));
    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a!.sheets.updated + b!.sheets.updated).toBe(1);
    expect((await sheetOnBox()).name).toBe("Concurrent");
  });

  it("offline, or with bytes that do not match, nothing is written and the box keeps its copy", async () => {
    const pin = await dbB.mapFile.findFirstOrThrow({ where: { eventId: eventB.id, sourceHash } });
    await dbB.mapFile.update({ where: { id: pin.id }, data: { sourceHash: reimport.sourceHash, documentHash: reimport.documentHash } });
    cleanup.push(() => dbB.mapFile.update({ where: { id: pin.id }, data: { sourceHash, documentHash } }));
    await dbB.courseMap.update({ where: { id: sheetBId }, data: { name: "Offline edit" } });
    cleanup.push(() => dbB.courseMap.update({ where: { id: sheetBId }, data: { name: "Blå karta" } }));
    const digest = await raceDigest();
    const before = { files: await boxFiles(), sheet: await sheetOnBox() };

    const offline: LeasePeer = { ...jsonLeasePeerToB(), exportMapRows: async () => Promise.reject(new Error("fetch failed")) };
    await expect(refresh(offline)).rejects.toThrow("fetch failed");
    const tampered: LeasePeer = {
      ...jsonLeasePeerToB(),
      exportBlob: async (nameId, input) => {
        const slice = await leasePeerToB().exportBlob(nameId, input);
        const bytes = Buffer.from(slice.base64, "base64");
        bytes[0] ^= 0xff;
        return { ...slice, base64: bytes.toString("base64") };
      },
    };
    await expect(refresh(tampered)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await boxFiles()).toEqual(before.files);
    expect(await sheetOnBox()).toEqual(before.sheet);
    expect(await ctx.db.mapSource.findUnique({ where: { fileHash: reimport.sourceHash } })).toBeNull();
    expect(await ctx.db.mapDocument.findUnique({ where: { hash: reimport.documentHash } })).toBeNull();
    expect(await raceDigest()).toBe(digest);
  });

  it("a map re-imported on the cloud reaches the box: new source and document, the pin, the document route; the dormant patch goes", async () => {
    const digest = await raceDigest();
    const res = await refresh();
    expect(res).toMatchObject({ mapFiles: 2, patch: "deleted" });
    const docB = await dbB.mapDocument.findUniqueOrThrow({ where: { hash: reimport.documentHash } });
    expect(res!.fetchedBytes).toBe(reimport.bytes.length + docB.sizeBytes);
    const files = await boxFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ fileName: "lease.ocd", sourceHash: reimport.sourceHash, documentHash: reimport.documentHash, clubMapVersionId: null });
    expect(Buffer.from((await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash: reimport.sourceHash } })).bytes).equals(reimport.bytes)).toBe(true);
    expect(sha256((await ctx.db.mapDocument.findUniqueOrThrow({ where: { hash: reimport.documentHash } })).bytes)).toBe(reimport.documentHash);
    // The sheet's name edit came with it, and the box has no patch for the new pin.
    expect((await sheetOnBox()).name).toBe("Offline edit");
    expect(await ctx.db.mapPatch.findUnique({ where: { eventId: box.id } })).toBeNull();
    expect(await raceDigest()).toBe(digest);

    const server: FastifyInstance = Fastify({ logger: false });
    registerMapDocumentRoutes(server);
    await server.ready();
    const previousMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "proxy";
    resetDocumentAccessCache();
    try {
      const url = `/api/map-documents/${reimport.documentHash}?event=${CHECKOUT_NAME}&k=${KIOSK_KEY}`;
      const kiosk = await server.inject({ method: "GET", url, headers: { "accept-encoding": "identity" } });
      expect(kiosk.statusCode).toBe(200);
      expect(sha256(kiosk.rawPayload)).toBe(reimport.documentHash);
    } finally {
      if (previousMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousMode;
      resetDocumentAccessCache();
      await server.close();
    }

    // The pin moved back: the old document's patch returns verbatim, token exact; nothing fetched.
    await dbB.mapFile.updateMany({ where: { eventId: eventB.id, sourceHash: reimport.sourceHash }, data: { sourceHash, documentHash } });
    const back = await refresh();
    expect(back).toMatchObject({ mapFiles: 2, patch: "written", fetchedBytes: 0 });
    expect(await ctx.db.mapPatch.findUniqueOrThrow({ where: { eventId: box.id } })).toMatchObject({ documentHash, version: PATCH_VERSION, ops: PATCH_OPS });
  });

  it("runs on the settings cadence beside the settings refresh, and the two fail independently", async () => {
    _setLeasePeerFactory(() => jsonLeasePeerToB());
    try {
      await dbB.courseMap.update({ where: { id: sheetBId }, data: { name: "Cadence" } });
      await dbB.event.update({ where: { id: eventB.id }, data: { finishReceiptMessage: "Cadence!" } });
      await refreshAllSettingsOnce(ctx.db, PEER_URL, "test-sync-secret");
      expect((await sheetOnBox()).name).toBe("Cadence");
      expect((await ctx.db.event.findUniqueOrThrow({ where: { id: box.id } })).finishReceiptMessage).toBe("Cadence!");

      // A cloud that predates exportMapRows: settings still follow, the map copy stays.
      _setLeasePeerFactory(() => ({ ...jsonLeasePeerToB(), exportMapRows: async () => Promise.reject(new Error("No procedure found")) }));
      await dbB.courseMap.update({ where: { id: sheetBId }, data: { name: "Not yet" } });
      await dbB.event.update({ where: { id: eventB.id }, data: { finishReceiptMessage: "Still!" } });
      await refreshAllSettingsOnce(ctx.db, PEER_URL, "test-sync-secret");
      expect((await sheetOnBox()).name).toBe("Cadence");
      expect((await ctx.db.event.findUniqueOrThrow({ where: { id: box.id } })).finishReceiptMessage).toBe("Still!");
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
      await dbB.event.update({ where: { id: eventB.id }, data: { finishReceiptMessage: "" } });
    }
  });

  it("a forwarded layout write is on the box, with the cloud's token, when its reply arrives", async () => {
    const TOKEN_3 = SHEET_VERSION + 3n;
    // A stub cloud that executes the write on B, as the real cloud would.
    const cloud = Fastify({ logger: false });
    cloud.post("/trpc/*", async () => {
      await dbB.courseMap.update({ where: { id: sheetBId }, data: { name: "Forwarded", version: TOKEN_3 } });
      return { result: { data: { version: TOKEN_3.toString() } } };
    });
    const address = await cloud.listen({ port: 0, host: "127.0.0.1" });
    const previous = { role: process.env.NODE_ROLE, peer: process.env.SYNC_PEER_URL };
    process.env.NODE_ROLE = "venue";
    process.env.SYNC_PEER_URL = address;
    const venue = Fastify({ logger: false });
    _setLeasePeerFactory(() => jsonLeasePeerToB());
    try {
      registerVenueForwarder(venue);
      venue.post("/trpc/*", async () => ({ result: { data: "local" } }));
      await venue.ready();
      // The header the web's tRPC clients send (\`x-event-id\` is the peers').
      const headers = { "content-type": "application/json", "x-competition-id": CHECKOUT_NAME };
      const reply = await venue.inject({ method: "POST", url: "/trpc/courseMap.update", headers, payload: { seq: 1, name: "Forwarded" } });
      expect(reply.statusCode).toBe(200);
      expect(await sheetOnBox()).toMatchObject({ name: "Forwarded", version: TOKEN_3 });
    } finally {
      _setLeasePeerFactory(() => leasePeerToB());
      if (previous.role === undefined) delete process.env.NODE_ROLE;
      else process.env.NODE_ROLE = previous.role;
      process.env.SYNC_PEER_URL = previous.peer ?? PEER_URL;
      await venue.close();
      await cloud.close();
    }
  });

  it("a slow refresh after a forwarded write holds the reply only for the bound", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    _setLeasePeerFactory(() => ({
      ...jsonLeasePeerToB(),
      exportMapRows: async () => {
        await gate;
        return exportMapRows(dbB, eventB.id);
      },
    }));
    try {
      const started = Date.now();
      await refreshAfterForward(CHECKOUT_NAME, PEER_URL, 50);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      release();
      _setLeasePeerFactory(() => leasePeerToB());
      // Refreshes of one event queue: this one returns after the held one finished.
      await refresh();
    }
  });
});

describe("a box that is no longer the holder stops writing (SYNC-08)", () => {
  async function checkedOutVenue() {
    await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    const local = await ctx.db.event.findUniqueOrThrow({
      where: { nameId: CHECKOUT_NAME },
      select: { id: true, nameId: true, zeroTime: true },
    });
    return { local, venue: makeCaller({ id: local.id, nameId: local.nameId, zeroTime: local.zeroTime }) };
  }

  async function withVenueRole<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.NODE_ROLE;
    process.env.NODE_ROLE = "venue";
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.NODE_ROLE;
      else process.env.NODE_ROLE = previous;
    }
  }

  const punchEntry = () => ({
    id: randomUUID(),
    type: "punch.recorded",
    competitionId: CHECKOUT_NAME,
    stationId: "station-x",
    timestamp: Date.now(),
    payload: { cardNo: 800200, controlCode: 77, time: 361000 },
  });

  it("lease.holder answers who holds the lease, behind the shared secret", async () => {
    const peerCaller = makeCaller(ctx.event, { syncSecret: "test-sync-secret" });
    expect(await peerCaller.lease.holder()).toMatchObject({ holderNodeId: null });
    await acquireLease(ctx.db, ctx.eventId, "venue-h");
    try {
      expect(await peerCaller.lease.holder()).toMatchObject({ holderNodeId: "venue-h" });
      await expect(caller.lease.holder()).rejects.toBeTruthy();
    } finally {
      await releaseLease(ctx.db, ctx.eventId, { forced: true });
    }
  });

  it("a revived box that was taken over releases itself, keeps shipping its backlog and refuses new race writes", async () => {
    const { local, venue } = await checkedOutVenue();
    try {
      await venue.runner.create({ name: "Backlog Berit", classId: 1, cardNo: 8_300_001 });
      // The cloud takes over without the box's cooperation.
      await releaseLease(dbB, eventB.id, { forced: true });

      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await shipAllOnce(ctx.db, PEER_URL, transportToB(), leasePeerToB());
        expect(err.mock.calls.flat().join(" ")).toContain("taken over");
      } finally {
        err.mockRestore();
      }
      expect(await getActiveLease(ctx.db, local.id)).toBeNull();
      const last = await ctx.db.eventLease.findFirstOrThrow({ where: { eventId: local.id }, orderBy: { id: "desc" } });
      expect(last.forced).toBe(true);
      // The backlog reached the cloud in the same pass.
      expect(await dbB.runner.count({ where: { eventId: eventB.id, cardNo: 8_300_001 } })).toBe(1);

      await withVenueRole(async () => {
        await expect(venue.race.recordFinish({ id: 1, finishTimeAbsolute: 366000 })).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          message: expect.stringContaining("checked in or taken over"),
        });
      });
      // A checkin on the revived box is an idempotent no-op, not an error.
      expect(await venue.lease.checkin()).toMatchObject({ ok: true, alreadyReleased: true });
    } finally {
      await undoCheckout();
    }
  });

  it("an unreachable peer, or one that still lists this box, changes nothing", async () => {
    const { local } = await checkedOutVenue();
    try {
      await shipAllOnce(ctx.db, PEER_URL, transportToB(), {
        ...leasePeerToB(),
        holder: async () => {
          throw new Error("offline");
        },
      });
      expect((await getActiveLease(ctx.db, local.id))?.holderNodeId).toBe("cloud");
      await shipAllOnce(ctx.db, PEER_URL, transportToB(), leasePeerToB());
      expect((await getActiveLease(ctx.db, local.id))?.holderNodeId).toBe("cloud");
    } finally {
      await undoCheckout();
    }
  });

  it("a user push to a checked-in venue copy is refused whole and writes nothing; a held-elsewhere copy still accepts it", async () => {
    const { local, venue } = await checkedOutVenue();
    try {
      expect((await venue.lease.checkin()).ok).toBe(true);
      const before = await ctx.db.journalEntry.count({ where: { eventId: local.id } });
      await withVenueRole(async () => {
        await expect(venue.events.push({ events: [punchEntry()] })).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
        });
        // The node-secret path (the other node's shipper) stays open.
        const peerVenue = makeCaller(
          { id: local.id, nameId: local.nameId, zeroTime: local.zeroTime },
          { syncSecret: "test-sync-secret" },
        );
        expect((await peerVenue.events.push({ events: [punchEntry()] })).synced).toHaveLength(1);
      });
      expect(await ctx.db.journalEntry.count({ where: { eventId: local.id } })).toBe(before + 1);
    } finally {
      await undoCheckout();
    }
  });

  it("the cloud warns for every entry a force-taken-over holder still delivers, and applies them", async () => {
    await acquireLease(ctx.db, ctx.eventId, "venue-stale");
    await releaseLease(ctx.db, ctx.eventId, { forced: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entry = (cardNo: number) => ({
        id: randomUUID(),
        type: "punch.recorded",
        competitionId: ctx.nameId,
        stationId: "venue-stale",
        timestamp: Date.now(),
        payload: { cardNo, controlCode: 56, time: 362000 },
      });
      const stale = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-stale" });
      const e1 = entry(800101);
      const res = await stale.events.push({ events: [e1, entry(800102)] });
      expect(res.synced).toHaveLength(2);
      const stalls = warn.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("stale-holder entry"));
      expect(stalls).toHaveLength(2);
      expect(stalls[0]).toContain(e1.id);
      // A replay is not newly applied: no further warning.
      await stale.events.push({ events: [e1] });
      expect(warn.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("stale-holder entry"))).toHaveLength(2);
      // A node that never held the lease is not stale.
      const other = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-never" });
      await other.events.push({ events: [entry(800103)] });
      expect(warn.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("stale-holder entry"))).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a peer of another version (SYNC-17)", () => {
  const warnQuiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("checks out from a newer cloud whose rows carry columns this schema lacks, and reports the schema difference", async () => {
    const warn = warnQuiet();
    _setLeasePeerFactory(() => ({
      ...leasePeerToB(),
      exportSnapshot: async () => {
        const snap = await exportEventSnapshot(dbB, eventB);
        const extra = { columnFromTheFuture: "x", anotherOne: 3 };
        return {
          ...snap,
          schema: "29991231000000_from_the_future",
          event: { ...snap.event, ...extra },
          tables: Object.fromEntries(
            Object.entries(snap.tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r, ...extra }))]),
          ) as typeof snap.tables,
        };
      },
    }));
    try {
      const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME });
      expect(res).toMatchObject({ ok: true, peerSchema: "29991231000000_from_the_future" });
      expect(res.localSchema).toEqual(expect.stringMatching(/^\d{8,}_/));
      const local = await ctx.db.event.findUniqueOrThrow({ where: { nameId: CHECKOUT_NAME }, select: { id: true } });
      expect(await ctx.db.runner.count({ where: { eventId: local.id } })).toBe(await dbB.runner.count({ where: { eventId: eventB.id } }));
      expect(await ctx.db.course.count({ where: { eventId: local.id } })).toBeGreaterThan(0);
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("columnFromTheFuture");
    } finally {
      warn.mockRestore();
      _setLeasePeerFactory(() => leasePeerToB());
      await undoCheckout();
    }
  });

  it("a checkout from a peer on the same schema reports no difference", async () => {
    try {
      const res = await caller.lease.checkout({ nameId: CHECKOUT_NAME });
      expect(res).not.toHaveProperty("peerSchema");
      expect((await exportEventSnapshot(dbB, eventB)).schema).toEqual(await schemaName(ctx.db));
    } finally {
      await undoCheckout();
    }
  });

  it("lease.holder reports this node's schema", async () => {
    const peerCaller = makeCaller(ctx.event, { syncSecret: "test-sync-secret" });
    expect((await peerCaller.lease.holder()).schema).toEqual(await schemaName(ctx.db));
  });

  it("a settings refresh with a column this schema lacks still applies the known ones", async () => {
    await caller.lease.checkout({ nameId: CHECKOUT_NAME });
    const warn = warnQuiet();
    try {
      const local = await ctx.db.event.findUniqueOrThrow({
        where: { nameId: CHECKOUT_NAME },
        select: { id: true, nameId: true, zeroTime: true },
      });
      const refreshed = await refreshCloudOwnedSettings(ctx.db, local, {
        ...leasePeerToB(),
        exportSettings: async () => ({
          ...((await dbB.event.findUniqueOrThrow({ where: { id: eventB.id } })) as unknown as Record<string, unknown>),
          finishReceiptMessage: "Skew ok",
          settingFromTheFuture: true,
        }),
      });
      expect(refreshed).toBe(true);
      expect((await ctx.db.event.findUniqueOrThrow({ where: { id: local.id }, select: { finishReceiptMessage: true } })).finishReceiptMessage).toBe("Skew ok");
    } finally {
      warn.mockRestore();
      await undoCheckout();
      await dbB.event.update({ where: { id: eventB.id }, data: { finishReceiptMessage: "" } });
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

describe("the delivery mark belongs to the current holder (H2)", () => {
  const entryFor = (stationId: string) => ({
    id: randomUUID(),
    type: "punch.recorded",
    competitionId: ctx.nameId,
    stationId,
    timestamp: Date.now(),
    payload: { cardNo: 800300, controlCode: 41, time: 363000 },
  });

  async function cloudEntry(): Promise<string> {
    const e = entryFor("cloud-reader");
    await ingestJournalEntries(ctx.db, ctx.event, [e], {});
    return e.id;
  }

  it("events.unshipped and ackShipped serve only the active holder; a stale box gets nothing and cannot ack", async () => {
    await acquireLeaseForPeer(ctx.db, ctx.eventId, "venue-b");
    try {
      const id = await cloudEntry();
      const stale = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-a" });
      expect((await stale.events.unshipped({ limit: 50 })).entries).toEqual([]);
      await expect(stale.events.ackShipped({ ids: [id] })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await ctx.db.journalEntry.findUniqueOrThrow({ where: { id } })).pushedAt).toBeNull();

      const holder = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-b" });
      expect((await holder.events.unshipped({ limit: 50 })).entries.map((e) => e.id)).toContain(id);
      expect((await holder.events.ackShipped({ ids: [id] })).marked).toBe(1);
      expect((await holder.events.unshipped({ limit: 50 })).entries.map((e) => e.id)).not.toContain(id);
    } finally {
      await releaseLease(ctx.db, ctx.eventId);
    }
  });

  it("with no active lease nothing is served or acked; a caller that sends no node id is refused even while a lease is held", async () => {
    const id = await cloudEntry();
    const anyBox = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-b" });
    expect((await anyBox.events.unshipped({ limit: 50 })).entries).toEqual([]);
    await expect(anyBox.events.ackShipped({ ids: [id] })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await acquireLease(ctx.db, ctx.eventId, "venue-b");
    try {
      const noHeader = makeCaller(ctx.event, { syncSecret: "test-sync-secret" });
      expect((await noHeader.events.unshipped({ limit: 50 })).entries).toEqual([]);
      await expect(noHeader.events.ackShipped({ ids: [id] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await releaseLease(ctx.db, ctx.eventId).catch(() => {});
    }
  });

  it("a refused non-holder pull is warned once per event and node", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _resetDeliveryRefusalWarnings();
    await acquireLeaseForPeer(ctx.db, ctx.eventId, "venue-b");
    try {
      const stale = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-a" });
      await stale.events.unshipped({ limit: 5 });
      await stale.events.unshipped({ limit: 5 });
      const other = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-c" });
      await other.events.unshipped({ limit: 5 });
      const msgs = warn.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("not the lease holder"));
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toContain("venue-a");
    } finally {
      warn.mockRestore();
      await releaseLease(ctx.db, ctx.eventId).catch(() => {});
    }
  });

  it("a pushed entry is marked delivered only by the lease holder (or with no lease); a stale box's backlog stays for the holder to pull", async () => {
    await acquireLeaseForPeer(ctx.db, ctx.eventId, "venue-b");
    try {
      const fromA = entryFor("venue-a");
      const a = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-a" });
      expect((await a.events.push({ events: [fromA] })).synced).toEqual([fromA.id]);
      expect((await ctx.db.journalEntry.findUniqueOrThrow({ where: { id: fromA.id } })).pushedAt).toBeNull();
      const b = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-b" });
      expect((await b.events.unshipped({ limit: 50 })).entries.map((e) => e.id)).toContain(fromA.id);

      const fromB = entryFor("venue-b");
      await b.events.push({ events: [fromB] });
      expect((await ctx.db.journalEntry.findUniqueOrThrow({ where: { id: fromB.id } })).pushedAt).not.toBeNull();
    } finally {
      await releaseLease(ctx.db, ctx.eventId);
    }
    const noLease = entryFor("venue-a");
    const a2 = makeCaller(ctx.event, { syncSecret: "test-sync-secret", peerNodeId: "venue-a" });
    await a2.events.push({ events: [noLease] });
    expect((await ctx.db.journalEntry.findUniqueOrThrow({ where: { id: noLease.id } })).pushedAt).not.toBeNull();
  });

  it("shipAllOnce pushes the backlog of a copy this node no longer holds but pulls nothing for it", async () => {
    await ctx.db.journalSyncState.upsert({
      where: { peerId_eventId: { peerId: PEER_URL, eventId: ctx.eventId } },
      create: { peerId: PEER_URL, eventId: ctx.eventId },
      update: {},
    });
    const calls = { push: 0, unshipped: 0 };
    const transport: PeerTransport = {
      push: async (_n, entries) => {
        calls.push += entries.length;
        return { synced: entries.map((e) => e.id), failed: [] };
      },
      unshipped: async () => {
        calls.unshipped++;
        return { entries: [], hasMore: false };
      },
      ack: async () => {},
    };
    try {
      await cloudEntry();
      // Checked in / taken over: lease history, no active lease.
      await acquireLease(ctx.db, ctx.eventId, nodeId());
      await releaseLease(ctx.db, ctx.eventId, { forced: true });
      await shipAllOnce(ctx.db, PEER_URL, transport);
      expect(calls.push).toBeGreaterThan(0);
      expect(calls.unshipped).toBe(0);

      // The holder pulls.
      await acquireLease(ctx.db, ctx.eventId, nodeId());
      await shipAllOnce(ctx.db, PEER_URL, transport);
      expect(calls.unshipped).toBe(1);
    } finally {
      await ctx.db.eventLease.deleteMany({ where: { eventId: ctx.eventId } });
      await ctx.db.journalSyncState.deleteMany({ where: { eventId: ctx.eventId } });
    }
  });
});
