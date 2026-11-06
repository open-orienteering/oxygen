import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import Fastify from "fastify";
import {
  createTestEvent,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { closeUploadServer, uploadClubMap, uploadEventMap } from "../helpers/upload-map.js";
import { parseOcadMapMetadata } from "../helpers/ocad-oracle.js";
import type { AuthUser } from "../../auth.js";
import { grantSystemGroup } from "../../permissions.js";
import { SYSTEM_GROUP_IDS } from "@oxygen/shared";
import { registerBackupRoute } from "../../backup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const suffix = randomBytes(4).toString("hex");

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let ctx: TestEventContext;
/** `club_maps` ids created here. */
let seriesIds: string[] = [];

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
  await closeUploadServer();
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
    const uploaded = await uploadClubMap(caller, buf, "test.ocd", `Club map ${suffix}`);
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
    // The fixture's north lines are drawn at grid north while the real
    // declination at 15°E/58.6°N is ≈ 6.5° E: the document's north report
    // gives that as *staleness* of the lines and must NOT touch the
    // georeference — ScalePar is authoritative. No OCAD parse at upload
    // since E5: the value is the pinned version's report.
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

    const dl = await caller.clubMap.download({ id: uploaded.id });
    expect(dl.fileName).toBe("test.ocd");
    expect(Buffer.from(dl.fileDataBase64, "base64").equals(buf)).toBe(true);
  });

  it("lists no north for a series without a version (docs/map-storage.md §4.6)", async () => {
    const series = await ctx.db.clubMap.create({ data: { name: `No version ${suffix}` }, select: { id: true } });
    seriesIds.push(series.id);

    const listed = (await makeCaller().clubMap.list()).find((m) => m.id === series.id);
    expect(listed).toMatchObject({ version: null, northDetection: null, meridianStalenessDeg: null, bounds: null, northOffset: null, scale: null });
    // No document, no thumbnail: an empty frame (§6.5, E4a).
    expect(listed?.previewUrl).toBeNull();
  });

  it("keeps accepting an unimportable upload without a preview", async () => {
    // OCAD magic (the chunk route sniffs it) followed by bytes no reader understands.
    const garbage = Buffer.concat([Buffer.from([0xad, 0x0c]), randomBytes(64)]);
    const uploaded = await uploadClubMap(makeCaller(), garbage, "unparseable.ocd");
    seriesIds.push(uploaded.id);
    expect(uploaded.meridianStalenessDeg).toBeNull();
    // The bytes are kept as the source (§3.1), whatever the import made of them.
    const source = await ctx.db.mapSource.findUniqueOrThrow({ where: { fileHash: sha256(garbage) }, select: { bytes: true } });
    expect(Buffer.from(source.bytes).equals(garbage)).toBe(true);

    // Listed as a series without a version, with its failed import.
    const listed = (await makeCaller().clubMap.list()).find((m) => m.id === uploaded.id);
    expect(listed).toMatchObject({
      version: null,
      versionCount: 0,
      importJob: { state: "failed" },
      fileName: "unparseable.ocd",
      sizeBytes: garbage.length,
      previewUrl: null,
    });
    // Nothing to download or adopt until a version exists (06 §6).
    await expect(makeCaller().clubMap.download({ id: uploaded.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      makeCaller(ctx.event).course.useClubMap({ clubMapId: uploaded.id }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
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
    const created = await uploadClubMap(asUploader, buf, "owned.ocd");
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

    // The series' creator may delete it; its versions cascade.
    await asUploader.clubMap.remove({ id: created.id });
    expect(await ctx.db.clubMap.count({ where: { id: created.id } })).toBe(0);
    expect(await ctx.db.clubMapVersion.count({ where: { clubMapId: created.id } })).toBe(0);
  });

  it("copies a library map onto an event and keeps editor course lengths derived", async () => {
    const buf = readFileSync(FIXTURE);
    const caller = makeCaller(ctx.event);
    const uploaded = await uploadClubMap(caller, buf, "event-copy.ocd");
    seriesIds.push(uploaded.id);

    // Manual library correction must flow into the event MapFile.
    const rotated = await caller.clubMap.setRotation({ id: uploaded.id, degrees: 4.5 });
    expect(rotated).toEqual({ success: true, rotationCorrection: 4.5 });
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
    expect(before?.lengthSource).toBe("derived");

    const used = await caller.course.useClubMap({ clubMapId: uploaded.id });
    expect(used.success).toBe(true);
    expect(used.fileName).toBe("event-copy.ocd");
    expect(used.size).toBe(buf.length);
    expect(used.rotationCorrection).toBe(4.5);

    const mapRow = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.eventId },
    });
    expect(mapRow?.fileName).toBe("event-copy.ocd");
    expect(mapRow!.sourceHash).toBe(sha256(buf));
    expect(mapRow!.fromClubLibrary).toBe(true);
    expect(mapRow!.rotationCorrection).toBe(4.5);
    // The quick-access columns are the pin's (docs/map-storage.md §6.4),
    // written when the copy's import job pinned the document.
    expect(mapRow!.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mapRow!.scale).toBeGreaterThan(0);
    expect(mapRow!.bounds).toBeTruthy();
    expect(mapRow!.calibration).toBeTruthy();

    const meta = await caller.course.mapMetadata();
    expect(meta).toBeTruthy();
    expect(meta!.scale).toBeGreaterThan(0);
    expect(meta!.bounds.north).toBeGreaterThan(meta!.bounds.south);
    expect(meta!.calibration!.length).toBeGreaterThanOrEqual(3);
    expect(meta!.rotationCorrection).toBe(4.5);

    const after = await ctx.db.course.findFirst({
      where: { eventId: ctx.eventId, seq: course.id },
    });
    expect(after?.lengthSource).toBe("derived");
    expect(after?.legs).not.toBeNull();

    await uploadEventMap(caller, ctx.nameId, buf, "replaced.ocd");
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
    const result = await uploadEventMap(caller, ctx.nameId, buf, "stale-lines.ocd");
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

  it("an unpinned map row answers with its stored columns, no document and no north", async () => {
    const caller = makeCaller(ctx.event);
    // A row with neither source nor pin — after E5 only a soft-deleted
    // event can hold one (the drops migration's guard).
    await ctx.db.mapFile.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.mapFile.create({
      data: { eventId: ctx.eventId, fileName: "legacy.ocd" },
    });

    const meta = await caller.course.mapMetadata();
    expect(meta).not.toBeNull();
    expect(meta).toMatchObject({ documentHash: null, bounds: null, scale: null, meridianStalenessDeg: null });

    const row = await ctx.db.mapFile.findFirstOrThrow({
      where: { eventId: ctx.eventId },
    });
    expect(row.bounds).toBeNull();
    expect(row.northDetection).toBeNull();
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
    const created = await uploadClubMap(asUploader, buf, "secret.ocd");
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

    await uploadEventMap(asManager, ctx.nameId, buf, "own.ocd");
    const own = await asManager.course.downloadMap();
    expect(own?.fileName).toBe("own.ocd");
    // The bytes come from map_sources (E5: no copy on map_files).
    expect(Buffer.from(own!.fileDataBase64, "base64").equals(buf)).toBe(true);

    const library = await uploadClubMap(asAdmin, buf, "library.ocd");
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
    const library = await uploadClubMap(
      makeCaller(ctx.event, { user: admin, authEnabled: true, identityEmail: admin.email }),
      buf,
      "backup-lib.ocd",
    );
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
