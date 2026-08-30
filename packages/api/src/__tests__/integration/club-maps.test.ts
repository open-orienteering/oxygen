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

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const suffix = randomBytes(4).toString("hex");

let ctx: TestEventContext;
let uploadedIds: bigint[] = [];

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
  if (uploadedIds.length > 0) {
    await ctx.db.clubMapFile.deleteMany({ where: { id: { in: uploadedIds } } });
  }
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
    uploadedIds.push(BigInt(uploaded.id));
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
    const stored = await ctx.db.clubMapFile.findUnique({
      where: { id: BigInt(uploaded.id) },
      select: { previewPng: true },
    });
    expect(stored?.previewPng).not.toBeNull();

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
    uploadedIds.push(row.id);

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
    uploadedIds.push(BigInt(uploaded.id));

    const stored = await ctx.db.clubMapFile.findUnique({
      where: { id: BigInt(uploaded.id) },
      select: { fileData: true, previewPng: true },
    });
    expect(Buffer.from(stored!.fileData)).toEqual(garbage);
    expect(stored!.previewPng).toBeNull();
  });

  it("requires an invited user for preview REST access when auth is on", async () => {
    const buf = readFileSync(FIXTURE);
    const uploaded = await makeCaller().clubMap.upload({
      fileName: "guarded-preview.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    uploadedIds.push(BigInt(uploaded.id));
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
        url: `/api/club-map-preview/${uploaded.id}`,
      });
      expect(anonymous.statusCode).toBe(401);

      const invited = await server.inject({
        method: "GET",
        url: `/api/club-map-preview/${uploaded.id}`,
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
    uploadedIds.push(BigInt(created.id));

    const asStranger = makeCaller(null, {
      user: stranger,
      authEnabled: true,
      identityEmail: stranger.email,
    });
    await expect(asStranger.clubMap.remove({ id: created.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("copies a library map onto an event and rebuilds editor geometry", async () => {
    const buf = readFileSync(FIXTURE);
    const caller = makeCaller(ctx.event);
    const uploaded = await caller.clubMap.upload({
      fileName: "event-copy.ocd",
      fileDataBase64: buf.toString("base64"),
    });
    uploadedIds.push(BigInt(uploaded.id));

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

    await ctx.db.mapTile.create({
      data: {
        eventId: ctx.eventId,
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

    const mapRow = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.eventId },
    });
    expect(mapRow?.fileName).toBe("event-copy.ocd");
    expect(Buffer.from(mapRow!.fileData).equals(buf)).toBe(true);
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

    const tiles = await ctx.db.mapTile.count({ where: { eventId: ctx.eventId } });
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
    expect(await ctx.db.mapFile.count({ where: { eventId: ctx.eventId } })).toBe(1);
  });

  it("backfills metadata for a legacy map row on first mapMetadata read", async () => {
    const buf = readFileSync(FIXTURE);
    const caller = makeCaller(ctx.event);
    // Simulate a pre-migration row: blob only, no parsed metadata.
    await ctx.db.mapFile.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.mapFile.create({
      data: { eventId: ctx.eventId, fileName: "legacy.ocd", fileData: buf },
    });

    const meta = await caller.course.mapMetadata();
    expect(meta).toBeTruthy();
    expect(meta!.bounds.north).toBeGreaterThan(meta!.bounds.south);

    const row = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.eventId },
    });
    expect(row!.bounds).toBeTruthy();
    expect(row!.calibration).toBeTruthy();
  });

  it("rejects creating an event whose slug would be library", async () => {
    const caller = makeCaller();
    await expect(
      caller.competition.create({ name: "library", date: "2099-01-01" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
