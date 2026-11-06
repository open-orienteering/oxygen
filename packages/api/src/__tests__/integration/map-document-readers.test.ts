/**
 * The server readers of the pinned map document end to end
 * (docs/map-storage.md §4.6, slice E1): every event — `legacy` included —
 * reads its pinned document; no pin answers "no map", never an OCAD
 * parse; `course.mapMetadata` answers for every map row; `importCourses`
 * leaves `uploaded_at` alone; the pin syncs control lat/lng.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { applyEventMap } from "../../event-map.js";
import { loadEventCrs } from "../../event-crs.js";
import { loadEventMapObjects } from "../../event-map-objects.js";
import { getBaseMapInfo, getBaseMapInfoOrNull } from "../../course-maps/map-source.js";
import { frameFromOcadCrs, mapMmToWgs84, type OcadCrs } from "../../map-projection.js";
import { mapGeo } from "@oxygen/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let documentHash: string;

/** Per-run trailer: content-addressed rows are global (see map-documents.test.ts). */
const uniqueBytes = (tag: string) => Buffer.concat([readFileSync(FIXTURE), Buffer.from(`${tag}-${randomBytes(4).toString("hex")}`)]);

async function legacyCrs(): Promise<OcadCrs> {
  const mod = (await import("ocad2geojson")) as unknown as { readOcad(b: Buffer, o?: object): Promise<{ getCrs(): OcadCrs }> };
  return (await mod.readOcad(readFileSync(FIXTURE), { quietWarnings: true })).getCrs();
}

beforeAll(async () => {
  ctx = await createTestEvent("document_readers");
  caller = makeCaller(ctx.event);
  // Since E3 a new event gets `vector` from the column default; nothing
  // reads the column (docs/map-pipeline-switch.md, history note).
  expect((await ctx.db.event.findUniqueOrThrow({ where: { id: ctx.eventId } })).mapPipeline).toBe("vector");
  // A positioned control before the map: the pin gives it lat/lng.
  await ctx.db.control.create({ data: { eventId: ctx.eventId, codes: "31", xpos: 10, ypos: 20, lat: 1, lng: 2 } });
  const applied = await applyEventMap(ctx.db, ctx.eventId, "test.ocd", uniqueBytes("readers"));
  expect(applied.documentHash).toMatch(/^[0-9a-f]{64}$/);
  documentHash = applied.documentHash!;
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  await disconnect();
});

describe("an event reads its pinned document", () => {
  it("CRS: the document's frame, the legacy positions", async () => {
    const frame = await loadEventCrs(ctx.db, ctx.eventId);
    const legacy = frameFromOcadCrs(await legacyCrs())!;
    const now = mapMmToWgs84(10, 20, frame!)!;
    const before = mapGeo.paperToWgs84(legacy, 1000, 2000)!;
    expect(Math.abs(now.lat - before.lat)).toBeLessThan(1e-8);
    expect(Math.abs(now.lng - before.lng)).toBeLessThan(1e-8);
  });

  it("the pin synced the control's lat/lng", async () => {
    const control = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "31" } });
    const expected = mapMmToWgs84(10, 20, (await loadEventCrs(ctx.db, ctx.eventId))!)!;
    expect(control.lat).toBeCloseTo(expected.lat, 9);
    expect(control.lng).toBeCloseTo(expected.lng, 9);
  });

  it("autodetect: suggestions from the document's objects", async () => {
    // The fixture's boulder (ISOM 204) at 68 / 42 mm.
    const { candidates } = await caller.control.suggestDescription({ x: 68, y: 42 });
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("print scale, tilt and the document itself from the pin", async () => {
    const info = await getBaseMapInfo(ctx.db, ctx.eventId);
    expect(info.scale).toBe((await legacyCrs()).scale);
    expect(info.version).toBe(documentHash);
    expect(info.document).toEqual({ hash: documentHash });
  });
});

describe("course.mapMetadata", () => {
  it("answers with the document hash and north from the report", async () => {
    const meta = await caller.course.mapMetadata();
    expect(meta).not.toBeNull();
    expect(meta!.documentHash).toBe(documentHash);
    expect(meta!.scale).toBe((await legacyCrs()).scale);
    expect(meta!.resolvedBy).toBe("scale");
  });

  it("does not need a render key", async () => {
    const row = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } });
    await ctx.db.mapFile.update({ where: { id: row.id }, data: { renderKey: null } });
    try {
      const meta = await caller.course.mapMetadata();
      expect(meta?.documentHash).toBe(documentHash);
      expect(meta?.renderKey).toBeNull();
      // Nothing computed it on read.
      expect((await ctx.db.mapFile.findUniqueOrThrow({ where: { id: row.id } })).renderKey).toBeNull();
    } finally {
      await ctx.db.mapFile.update({ where: { id: row.id }, data: { renderKey: row.renderKey } });
    }
  });
});

describe("importCourses", () => {
  it("leaves map_files.uploaded_at alone", async () => {
    const before = (await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } })).uploadedAt;
    await caller.course.importCourses({ ocdBase64: readFileSync(FIXTURE).toString("base64") });
    const after = (await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } })).uploadedAt;
    expect(after.getTime()).toBe(before.getTime());
  });
});

describe("no pinned document: no map", () => {
  it("every reader answers no map while the row has no document_hash", async () => {
    await ctx.db.mapFile.updateMany({ where: { eventId: ctx.eventId }, data: { documentHash: null } });
    try {
      expect(await loadEventCrs(ctx.db, ctx.eventId)).toBeNull();
      expect(await loadEventMapObjects(ctx.db, ctx.eventId)).toBeNull();
      expect((await caller.control.suggestDescription({ x: 68, y: 42 })).candidates).toEqual([]);
      expect(await getBaseMapInfoOrNull(ctx.db, ctx.eventId)).toBeNull();
      // controlCoordinates keeps the stored lat/lng rather than converting.
      const stored = await ctx.db.control.findFirstOrThrow({ where: { eventId: ctx.eventId, codes: "31" } });
      const listed = (await caller.course.controlCoordinates()).find((c) => c.code === "31");
      expect(listed?.lat).toBe(stored.lat);
      // mapMetadata still answers for the row, without a document.
      const meta = await caller.course.mapMetadata();
      expect(meta).not.toBeNull();
      expect(meta!.documentHash).toBeNull();
      expect(meta!.meridianStalenessDeg).toBeNull();
    } finally {
      await ctx.db.mapFile.updateMany({ where: { eventId: ctx.eventId }, data: { documentHash } });
    }
  });

  it("a rotation change without a pin stores only the correction", async () => {
    const before = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } });
    await ctx.db.mapFile.updateMany({ where: { eventId: ctx.eventId }, data: { documentHash: null } });
    try {
      await caller.course.setMapRotation({ degrees: 2 });
      const after = await ctx.db.mapFile.findFirstOrThrow({ where: { eventId: ctx.eventId } });
      expect(after.rotationCorrection).toBe(2);
      expect(after.bounds).toEqual(before.bounds);
      expect(after.calibration).toEqual(before.calibration);
      expect(after.northOffset).toBe(before.northOffset);
    } finally {
      await ctx.db.mapFile.updateMany({ where: { eventId: ctx.eventId }, data: { documentHash } });
      await caller.course.setMapRotation({ degrees: 0 });
    }
  });

  it("an event without a map answers null", async () => {
    const bare = await createTestEvent("document_readers_bare");
    try {
      expect(await makeCaller(bare.event).course.mapMetadata()).toBeNull();
      expect(await loadEventCrs(bare.db, bare.eventId)).toBeNull();
    } finally {
      await bare.cleanup();
    }
  });
});
