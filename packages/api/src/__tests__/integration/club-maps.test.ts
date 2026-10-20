import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import Fastify from "fastify";
import {
  createTestEvent,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import type { AuthUser } from "../../auth.js";
import type { GeoJSONFeatureCollection } from "../../iof-course-parser.js";
import {
  getOrCreateClubMapPreview,
  registerClubMapPreviewRoute,
} from "../../club-map-preview.js";
import { grantSystemGroup } from "../../permissions.js";
import { SYSTEM_GROUP_IDS } from "@oxygen/shared";
import { registerBackupRoute } from "../../backup.js";
import { parseOcadMapMetadata } from "../../event-map.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const suffix = randomBytes(4).toString("hex");

let ctx: TestEventContext;
/** `club_maps` ids created here; their linked legacy rows go with them. */
let seriesIds: string[] = [];
/** Unlinked `club_map_files` rows inserted directly. */
let legacyOnlyIds: bigint[] = [];

/**
 * A pre-pipeline row that the backfill has already linked to a series
 * (no version yet): the shape the list reads raster metadata from.
 */
async function linkedLegacyRow(data: { name: string; fileName: string; fileData: Buffer }) {
  const series = await ctx.db.clubMap.create({ data: { name: data.name }, select: { id: true } });
  seriesIds.push(series.id);
  const row = await ctx.db.clubMapFile.create({
    data: { ...data, sizeBytes: data.fileData.length, clubMapId: series.id },
  });
  return { seriesId: series.id, legacyId: row.id };
}

async function legacyRowOf(seriesId: string) {
  return ctx.db.clubMapFile.findFirstOrThrow({ where: { clubMapId: seriesId } });
}

function asUser(row: {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  active: boolean;
}): AuthUser {
  return row;
}

beforeAll(async () => {
  ctx = await createTestEvent("club_maps");
});

afterAll(async () => {
  await ctx.db.clubMapFile.deleteMany({
    where: { OR: [{ id: { in: legacyOnlyIds } }, { clubMapId: { in: seriesIds } }] },
  });
  await ctx.db.clubMap.deleteMany({ where: { id: { in: seriesIds } } });
  await ctx.db.user.deleteMany({
    where: { email: { endsWith: "@club-map-test.example" } },
  });
  await ctx.cleanup();
});

describe("club map library", () => {
  it("uploads, lists without blob, renames, and round-trips download bytes", async () => {
    const buf = readFileSync(FIXTURE);
    const caller = makeCaller();
    const uploaded = await caller.clubMap.upload({
      fileName: "test.ocd",
      name: `Club map ${suffix}`,
      fileDataBase64: buf.toString("base64"),
    });
    seriesIds.push(uploaded.id);
    expect(uploaded.sizeBytes).toBe(buf.length);

    const list = await caller.clubMap.list();
    const row = list.find((m) => m.id === uploaded.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("fileData");
    expect(row!.fileName).toBe("test.ocd");
    expect(row!.sizeBytes).toBe(buf.length);
    expect(row!.scale).toBeGreaterThan(0);
    expect(row!.bounds).toBeTruthy();
    expect(row!.bounds!.north).toBeGreaterThan(row!.bounds!.south);
    // Keyed by the series; the version names the source and the document.
    expect(uploaded.id).toMatch(/^[0-9a-f-]{36}$/);
    const series = await ctx.db.clubMap.findUniqueOrThrow({
      where: { id: uploaded.id },
      include: { versions: true },
    });
    expect(row!.version).toMatchObject({
      id: series.versions[0].id,
      seq: 1,
      label: "test.ocd",
      sourceHash: series.versions[0].sourceHash,
      documentHash: series.versions[0].documentHash,
    });
    expect(row!.versionCount).toBe(1);
    expect(row!.importJob).toBeNull();
    // The card's "to review" count is the document report's (map-symbols.md §8.7);
    // read from the report, since club decisions of parallel suites move it.
    const doc = await ctx.db.mapDocument.findUniqueOrThrow({
      where: { hash: series.versions[0].documentHash },
      select: { report: true },
    });
    const symbols = (doc.report as { matching: { symbols: { suggested: number; reviewed: number } } }).matching.symbols;
    expect(row!.review).toEqual({ suggested: symbols.suggested, reviewed: symbols.reviewed });
    expect(row!.review!.suggested + row!.review!.reviewed).toBeGreaterThan(0);
    expect(row!.previewUrl).toBe(
      `/api/map-documents/${series.versions[0].documentHash}/thumbnail.png`,
    );
    const stored = await legacyRowOf(uploaded.id);
    expect(stored.previewPng).not.toBeNull();

    // The fixture's north lines are drawn at grid north while the real
    // declination at 15°E/58.6°N is ≈ 6.5° E: the detection must report
    // that as *staleness* of the lines and must NOT touch the
    // georeference — ScalePar is authoritative.
    expect(uploaded.rotationCorrection).toBe(0);
    expect(uploaded.meridianStalenessDeg).toBeGreaterThan(5);
    expect(uploaded.meridianStalenessDeg).toBeLessThan(8);
    expect(row!.rotationCorrection).toBe(0);
    expect(row!.meridianStalenessDeg).toBeCloseTo(uploaded.meridianStalenessDeg!, 1);
    expect(row!.northDetection).not.toHaveProperty("shouldAutoApply");
    expect(row!.northDetection).not.toHaveProperty("suggestedCorrectionDeg");

    await caller.clubMap.rename({
      id: uploaded.id,
      name: `Renamed ${suffix}`,
    });
    const renamed = (await caller.clubMap.list()).find((m) => m.id === uploaded.id);
    expect(renamed?.name).toBe(`Renamed ${suffix}`);
    expect((await legacyRowOf(uploaded.id)).name).toBe(`Renamed ${suffix}`);

    const dl = await caller.clubMap.download({ id: uploaded.id });
    expect(dl.fileName).toBe("test.ocd");
    expect(Buffer.from(dl.fileDataBase64, "base64").equals(buf)).toBe(true);
  });

  it("backfills north detection for a legacy club map row on list", async () => {
    const buf = readFileSync(FIXTURE);
    // Simulate a row from before the north_detection column: blob only,
    // already linked to its series by the backfill.
    const legacy = await linkedLegacyRow({
      name: `Legacy north ${suffix}`,
      fileName: "legacy-north.ocd",
      fileData: buf,
    });

    const listed = (await makeCaller().clubMap.list()).find(
      (m) => m.id === legacy.seriesId,
    );
    // The fixture has 601 lines ≈ 6.5° stale — the backfilled analysis
    // must surface that on the very first list read.
    expect(listed?.meridianStalenessDeg).toBeGreaterThan(5);

    const persisted = await ctx.db.clubMapFile.findUniqueOrThrow({
      where: { id: legacy.legacyId },
      select: { northDetection: true },
    });
    expect(persisted.northDetection).toMatchObject({
      meridian: { count: 12 },
    });
  });

  it("persists an all-null detection for an unparseable legacy row (no re-parse loop)", async () => {
    const legacy = await linkedLegacyRow({
      name: `Legacy garbage ${suffix}`,
      fileName: "legacy-garbage.ocd",
      fileData: Buffer.from("not an OCAD file"),
    });

    const listed = (await makeCaller().clubMap.list()).find(
      (m) => m.id === legacy.seriesId,
    );
    // Analysed, nothing found — reported as "no north lines".
    expect(listed?.meridianStalenessDeg).toBeNull();
    const persisted = await ctx.db.clubMapFile.findUniqueOrThrow({
      where: { id: legacy.legacyId },
      select: { northDetection: true },
    });
    // Not NULL: the marker prevents re-parsing on every future list call.
    expect(persisted.northDetection).toMatchObject({ meridian: null });
  });

  it("backfills and persists a preview for a legacy club map", async () => {
    const buf = readFileSync(FIXTURE);
    const row = await ctx.db.clubMapFile.create({
      data: {
        name: `Legacy preview ${suffix}`,
        fileName: "legacy-preview.ocd",
        fileData: buf,
        sizeBytes: buf.length,
        previewPng: null,
      },
    });
    legacyOnlyIds.push(row.id);

    const png = await getOrCreateClubMapPreview(row.id);
    expect(png?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const persisted = await ctx.db.clubMapFile.findUnique({
      where: { id: row.id },
      select: { previewPng: true },
    });
    expect(persisted?.previewPng).not.toBeNull();
    const again = await getOrCreateClubMapPreview(row.id);
    expect(again?.equals(png!)).toBe(true);
  });

  it("keeps accepting an unparseable upload without a preview", async () => {
    const garbage = Buffer.from("not an OCAD file");
    const uploaded = await makeCaller().clubMap.upload({
      fileName: "unparseable.ocd",
      fileDataBase64: garbage.toString("base64"),
    });
    seriesIds.push(uploaded.id);

    const stored = await legacyRowOf(uploaded.id);
    expect(Buffer.from(stored.fileData)).toEqual(garbage);
    expect(stored.previewPng).toBeNull();

    // Listed as a series without a version, with its failed import.
    const listed = (await makeCaller().clubMap.list()).find((m) => m.id === uploaded.id);
    expect(listed).toMatchObject({
      version: null,
      versionCount: 0,
      importJob: { state: "failed" },
      fileName: "unparseable.ocd",
      sizeBytes: garbage.length,
      previewUrl: `/api/club-map-preview/${stored.id}`,
    });
    // Nothing to download or adopt until a version exists (06 §6).
    await expect(makeCaller().clubMap.download({ id: uploaded.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      makeCaller(ctx.event).course.useClubMap({ clubMapId: uploaded.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("does not list a legacy row the backfill has not linked to a series", async () => {
    const row = await ctx.db.clubMapFile.create({
      data: {
        name: `Unlinked ${suffix}`,
        fileName: "unlinked.ocd",
        fileData: Buffer.from("bytes"),
        sizeBytes: 5,
      },
    });
    legacyOnlyIds.push(row.id);
    const list = await makeCaller().clubMap.list();
    expect(list.find((m) => m.name === `Unlinked ${suffix}`)).toBeUndefined();
    // A read never starts imports or creates series.
    expect(
      await ctx.db.clubMapFile.findUniqueOrThrow({ where: { id: row.id }, select: { clubMapId: true } }),
    ).toEqual({ clubMapId: null });
  });

  it("rejects unknown and malformed library ids", async () => {
    const unknown = "00000000-0000-7000-8000-000000000000";
    await expect(makeCaller().clubMap.download({ id: unknown })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(makeCaller().clubMap.remove({ id: unknown })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(makeCaller(ctx.event).course.useClubMap({ clubMapId: unknown })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      makeCaller().clubMap.rename({ id: "42" as unknown as string, name: "x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("requires an invited user for preview REST access when auth is on", async () => {
    const buf = readFileSync(FIXTURE);
    const uploaded = await makeCaller().clubMap.upload({
      fileName: "guarded-preview.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    seriesIds.push(uploaded.id);
    const legacyId = (await legacyRowOf(uploaded.id)).id;
    const invitedEmail = `preview-${suffix}@club-map-test.example`;
    await ctx.db.user.create({
      data: {
        email: invitedEmail,
        displayName: "Preview User",
        isAdmin: false,
        active: true,
      },
    });

    const server = Fastify();
    registerClubMapPreviewRoute(server);
    const previousMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "proxy";
    try {
      const anonymous = await server.inject({
        method: "GET",
        url: `/api/club-map-preview/${legacyId}`,
      });
      expect(anonymous.statusCode).toBe(401);

      const invited = await server.inject({
        method: "GET",
        url: `/api/club-map-preview/${legacyId}`,
        headers: { "x-forwarded-email": invitedEmail },
      });
      expect(invited.statusCode).toBe(200);
      expect(invited.headers["content-type"]).toContain("image/png");
      expect(invited.headers["cache-control"]).toBe("private, max-age=3600");
    } finally {
      if (previousMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousMode;
      await server.close();
    }
  });

  it("forbids delete by a non-uploader non-admin when auth is on", async () => {
    const buf = readFileSync(FIXTURE);
    const uploader = asUser(
      await ctx.db.user.create({
        data: {
          email: `uploader-${suffix}@club-map-test.example`,
          displayName: "Uploader",
          isAdmin: false,
          active: true,
        },
      }),
    );
    const stranger = asUser(
      await ctx.db.user.create({
        data: {
          email: `stranger-${suffix}@club-map-test.example`,
          displayName: "Stranger",
          isAdmin: false,
          active: true,
        },
      }),
    );
    const asUploader = makeCaller(null, {
      user: uploader,
      authEnabled: true,
      identityEmail: uploader.email,
    });
    const created = await asUploader.clubMap.upload({
      fileName: "owned.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    seriesIds.push(created.id);

    const asStranger = makeCaller(null, {
      user: stranger,
      authEnabled: true,
      identityEmail: stranger.email,
    });
    await expect(asStranger.clubMap.remove({ id: created.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await ctx.db.clubMap.count({ where: { id: created.id } })).toBe(1);
    expect(await ctx.db.clubMapFile.count({ where: { clubMapId: created.id } })).toBe(1);

    // The series' creator may delete it; the linked legacy row goes too.
    await asUploader.clubMap.remove({ id: created.id });
    expect(await ctx.db.clubMap.count({ where: { id: created.id } })).toBe(0);
    expect(await ctx.db.clubMapFile.count({ where: { fileName: "owned.ocd", clubMapId: null } })).toBe(0);
  });

  it("copies a library map onto an event and rebuilds editor geometry", async () => {
    const buf = readFileSync(FIXTURE);
    const caller = makeCaller(ctx.event);
    const uploaded = await caller.clubMap.upload({
      fileName: "event-copy.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    seriesIds.push(uploaded.id);

    // Manual library correction must flow into the event MapFile.
    await caller.clubMap.setRotation({ id: uploaded.id, degrees: 4.5 });
    const clubRow = await legacyRowOf(uploaded.id);
    expect(clubRow.rotationCorrection).toBe(4.5);
    expect(
      (await ctx.db.clubMap.findUniqueOrThrow({ where: { id: uploaded.id } })).rotationCorrection,
    ).toBe(4.5);

    await caller.control.create({ codes: "201", xpos: 10, ypos: 20 });
    await caller.control.create({ codes: "202", xpos: 40, ypos: 20 });
    const course = await caller.course.create({
      name: "LibraryGeom",
      controlIds: [201, 202],
    });
    const before = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    expect(before?.geometrySource).toBe("editor");
    await ctx.db.course.update({
      where: { id: before!.id },
      data: { geometry: { type: "FeatureCollection", features: [] } },
    });

    // Seed an orphan tile row so we can assert GC after the map is replaced.
    await ctx.db.mapTile.create({
      data: {
        renderKey: "orphan-club-maps-seed",
        z: 1,
        x: 0,
        y: 0,
        tileData: Buffer.from([1, 2, 3]),
      },
    });

    const used = await caller.course.useClubMap({ clubMapId: uploaded.id });
    expect(used.success).toBe(true);
    expect(used.fileName).toBe("event-copy.ocd");
    expect(used.size).toBe(buf.length);
    expect(used.rotationCorrection).toBe(4.5);

    const mapRow = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.eventId },
    });
    expect(mapRow?.fileName).toBe("event-copy.ocd");
    expect(Buffer.from(mapRow!.fileData).equals(buf)).toBe(true);
    expect(mapRow!.fromClubLibrary).toBe(true);
    expect(mapRow!.rotationCorrection).toBe(4.5);
    // Metadata is parsed once at apply time and persisted, so
    // course.mapMetadata never has to re-parse the OCAD blob per query
    // (a multi-second stall on real maps that made the SW's NetworkFirst
    // timeout serve a stale null → blank map panel until a full reload).
    expect(mapRow!.scale).toBeGreaterThan(0);
    expect(mapRow!.bounds).toBeTruthy();
    expect(mapRow!.calibration).toBeTruthy();

    const meta = await caller.course.mapMetadata();
    expect(meta).toBeTruthy();
    expect(meta!.scale).toBeGreaterThan(0);
    expect(meta!.bounds.north).toBeGreaterThan(meta!.bounds.south);
    expect(meta!.calibration!.length).toBeGreaterThanOrEqual(3);
    expect(meta!.rotationCorrection).toBe(4.5);

    const tiles = await ctx.db.mapTile.count({
      where: { renderKey: "orphan-club-maps-seed" },
    });
    expect(tiles).toBe(0);

    const after = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    expect(after?.geometrySource).toBe("editor");
    const geomAfter = after?.geometry as unknown as GeoJSONFeatureCollection;
    expect(geomAfter.features.length).toBeGreaterThan(0);

    await caller.course.uploadMap({
      fileName: "replaced.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    const replaced = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.eventId },
    });
    expect(replaced?.fileName).toBe("replaced.ocd");
    expect(replaced?.fromClubLibrary).toBe(false);
    expect(await ctx.db.mapFile.count({ where: { eventId: ctx.eventId } })).toBe(1);
  });

  it("event map upload keeps ScalePar and reports north-line staleness", async () => {
    const buf = readFileSync(FIXTURE);
    const caller = makeCaller(ctx.event);
    const result = await caller.course.uploadMap({
      fileName: "stale-lines.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    // ≈ 6.5° stale would have been auto-applied by the retired detector.
    expect(result.rotationCorrection).toBe(0);
    expect(result.meridianStalenessDeg).toBeGreaterThan(5);

    const meta = await caller.course.mapMetadata();
    expect(meta!.rotationCorrection).toBe(0);
    expect(meta!.meridianStalenessDeg).toBeCloseTo(result.meridianStalenessDeg!, 1);
    // Bounds must be the file's own georeference, i.e. identical to a
    // parse with correction 0.
    const expected = await parseOcadMapMetadata(buf, 0);
    expect(meta!.bounds.north).toBeCloseTo(expected.bounds!.north, 9);
    expect(meta!.bounds.west).toBeCloseTo(expected.bounds!.west, 9);
    expect(meta!.northOffset).toBeCloseTo(expected.northOffset!, 9);
  });

  it("setRotation rejects unknown club map ids", async () => {
    await expect(
      makeCaller().clubMap.setRotation({ id: "00000000-0000-7000-8000-000000000000", degrees: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("backfills metadata and north detection for a legacy map row on first mapMetadata read", async () => {
    const buf = readFileSync(FIXTURE);
    const caller = makeCaller(ctx.event);
    // Simulate a pre-migration row: blob only, no parsed metadata, no
    // north detection.
    await ctx.db.mapFile.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.mapFile.create({
      data: { eventId: ctx.eventId, fileName: "legacy.ocd", fileData: buf },
    });

    const meta = await caller.course.mapMetadata();
    expect(meta).toBeTruthy();
    expect(meta!.bounds.north).toBeGreaterThan(meta!.bounds.south);
    // North analysis runs on the same first read, so the stale-lines
    // badge appears for old events too.
    expect(meta!.meridianStalenessDeg).toBeGreaterThan(5);

    const row = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.eventId },
    });
    expect(row!.bounds).toBeTruthy();
    expect(row!.calibration).toBeTruthy();
    expect(row!.northDetection).toMatchObject({ meridian: { count: 12 } });
  });

  it("rejects creating an event whose slug would be library", async () => {
    const caller = makeCaller();
    await expect(
      caller.competition.create({ name: "library", date: "2099-01-01" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("forbids club-map download by a non-uploader non-admin when auth is on", async () => {
    const buf = readFileSync(FIXTURE);
    const uploader = asUser(
      await ctx.db.user.create({
        data: {
          email: `dl-up-${suffix}@club-map-test.example`,
          displayName: "Downloader",
          isAdmin: false,
          active: true,
        },
      }),
    );
    const stranger = asUser(
      await ctx.db.user.create({
        data: {
          email: `dl-str-${suffix}@club-map-test.example`,
          displayName: "Stranger",
          isAdmin: false,
          active: true,
        },
      }),
    );
    const asUploader = makeCaller(null, {
      user: uploader,
      authEnabled: true,
      identityEmail: uploader.email,
    });
    const created = await asUploader.clubMap.upload({
      fileName: "secret.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    seriesIds.push(created.id);

    const asStranger = makeCaller(null, {
      user: stranger,
      authEnabled: true,
      identityEmail: stranger.email,
    });
    await expect(
      asStranger.clubMap.download({ id: created.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const roundTrip = await asUploader.clubMap.download({ id: created.id });
    expect(Buffer.from(roundTrip.fileDataBase64, "base64").equals(buf)).toBe(
      true,
    );
  });

  it("lets an event manager download an uploaded map but not a club-library copy", async () => {
    const buf = readFileSync(FIXTURE);
    const manager = asUser(
      await ctx.db.user.create({
        data: {
          email: `mgr-${suffix}@club-map-test.example`,
          displayName: "Manager",
          isAdmin: false,
          active: true,
        },
      }),
    );
    const admin = asUser(
      await ctx.db.user.create({
        data: {
          email: `adm-${suffix}@club-map-test.example`,
          displayName: "Admin",
          isAdmin: true,
          active: true,
        },
      }),
    );
    await grantSystemGroup(ctx.db, {
      eventId: ctx.eventId,
      userId: manager.id,
      groupId: SYSTEM_GROUP_IDS.eventAdmin,
      grantedBy: admin.id,
    });
    const asManager = makeCaller(ctx.event, {
      user: manager,
      authEnabled: true,
      identityEmail: manager.email,
    });
    const asAdmin = makeCaller(ctx.event, {
      user: admin,
      authEnabled: true,
      identityEmail: admin.email,
    });

    await asManager.course.uploadMap({
      fileName: "own.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    const own = await asManager.course.downloadMap();
    expect(own?.fileName).toBe("own.ocd");

    const library = await asAdmin.clubMap.upload({
      fileName: "library.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    seriesIds.push(library.id);
    await asManager.course.useClubMap({ clubMapId: library.id });
    await expect(asManager.course.downloadMap()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const adminDl = await asAdmin.course.downloadMap();
    expect(adminDl?.fileName).toBe("library.ocd");
  });

  it("requires instance admin to back up an event whose map came from the club library", async () => {
    const buf = readFileSync(FIXTURE);
    const manager = asUser(
      await ctx.db.user.create({
        data: {
          email: `bak-mgr-${suffix}@club-map-test.example`,
          displayName: "BackupMgr",
          isAdmin: false,
          active: true,
        },
      }),
    );
    const admin = asUser(
      await ctx.db.user.create({
        data: {
          email: `bak-adm-${suffix}@club-map-test.example`,
          displayName: "BackupAdm",
          isAdmin: true,
          active: true,
        },
      }),
    );
    await grantSystemGroup(ctx.db, {
      eventId: ctx.eventId,
      userId: manager.id,
      groupId: SYSTEM_GROUP_IDS.eventAdmin,
      grantedBy: admin.id,
    });
    const library = await makeCaller(ctx.event, {
      user: admin,
      authEnabled: true,
      identityEmail: admin.email,
    }).clubMap.upload({
      fileName: "backup-lib.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    seriesIds.push(library.id);
    await makeCaller(ctx.event, {
      user: manager,
      authEnabled: true,
      identityEmail: manager.email,
    }).course.useClubMap({ clubMapId: library.id });

    const server = Fastify();
    registerBackupRoute(server);
    const previousMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = "proxy";
    try {
      const asManager = await server.inject({
        method: "GET",
        url: `/api/backup/event?name=${ctx.nameId}`,
        headers: { "x-forwarded-email": manager.email },
      });
      expect(asManager.statusCode).toBe(403);

      const asAdmin = await server.inject({
        method: "GET",
        url: `/api/backup/event?name=${ctx.nameId}`,
        headers: { "x-forwarded-email": admin.email },
      });
      expect(asAdmin.statusCode).toBe(200);
    } finally {
      if (previousMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = previousMode;
      await server.close();
    }
  });
});
