/**
 * Exercises the data migration `20260918160000_reset_auto_north_corrections`
 * against seeded rows: automatically applied corrections are undone and
 * their derived metadata re-derived, manual corrections survive.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { parseOcadMapMetadata } from "../../event-map.js";
import { loadEventCrs } from "../../event-crs.js";
import { mapMmToWgs84 } from "../../map-projection.js";
import type { Prisma } from "../../generated/prisma/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
const MIGRATION = resolve(
  __dirname,
  "../../../prisma/migrations/20260918160000_reset_auto_north_corrections/migration.sql",
);

/** Legacy `north_detection` payload as the retired auto-apply wrote it. */
function legacyDetection(suggested: number) {
  return {
    declaredGrivationDeg: 0,
    declinationDeg: 6.4,
    trueNorthFromGridDeg: 0,
    meridian: { symbolId: 601000, count: 12, medianTiltDeg: 0, stddevDeg: 0 },
    suggestedCorrectionDeg: suggested,
    meridianGate: true,
    shouldAutoApply: true,
    centerLat: 58.64,
    centerLng: 15,
    asOf: "2026-01-01T00:00:00.000Z",
  } as unknown as Prisma.InputJsonValue;
}

function migrationStatements(): string[] {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    // map_tiles dropped event_id in 20260923180000; rewrite the historical
    // DELETE to the content-keyed form so this suite still validates the
    // correction-reset logic against the current schema.
    .map((sql) =>
      sql.includes("DELETE FROM oxygen.map_tiles")
        ? `DELETE FROM oxygen.map_tiles t
USING oxygen.map_files m
WHERE t.render_key = m.render_key
  AND m.rotation_correction <> 0
  AND m.north_detection IS NOT NULL
  AND (m.north_detection->>'shouldAutoApply')::boolean IS TRUE
  AND (m.north_detection->>'suggestedCorrectionDeg') IS NOT NULL
  AND abs(m.rotation_correction - (m.north_detection->>'suggestedCorrectionDeg')::double precision) < 1e-6`
        : sql,
    );
}

let autoCtx: TestEventContext;
let manualCtx: TestEventContext;
const clubIds: bigint[] = [];

beforeAll(async () => {
  autoCtx = await createTestEvent("reset_north_auto");
  manualCtx = await createTestEvent("reset_north_manual");
});

afterAll(async () => {
  if (clubIds.length > 0) {
    await autoCtx.db.clubMapFile.deleteMany({ where: { id: { in: clubIds } } });
  }
  await autoCtx.cleanup();
  await manualCtx.cleanup();
  await disconnect();
});

describe("reset_auto_north_corrections migration", () => {
  it("undoes auto-applied corrections, keeps manual ones, re-derives on read", async () => {
    const buf = readFileSync(FIXTURE);
    const db = autoCtx.db;
    const shifted = await parseOcadMapMetadata(buf, 1.7);

    // Event map with an auto-applied +1.7° and metadata derived from it.
    const autoRow = await db.mapFile.create({
      data: {
        eventId: autoCtx.eventId,
        fileName: "auto.ocd",
        fileData: buf,
        rotationCorrection: 1.7,
        northDetection: legacyDetection(1.7),
        scale: shifted.scale,
        bounds: shifted.bounds as unknown as Prisma.InputJsonValue,
        northOffset: shifted.northOffset,
        calibration: shifted.calibration as unknown as Prisma.InputJsonValue,
        renderKey: "reset-auto-key",
      },
    });
    await db.mapTile.create({
      data: {
        renderKey: "reset-auto-key",
        z: 3,
        x: 1,
        y: 1,
        tileData: Buffer.from([1]),
      },
    });
    // A positioned control whose lat/lng were computed under +1.7°.
    const control = await db.control.create({
      data: { eventId: autoCtx.eventId, codes: "41", xpos: 12, ypos: 8, lat: 1, lng: 2 },
    });

    // Event map with a *manual* correction (value differs from the
    // suggestion) — must survive untouched.
    const manualRow = await manualCtx.db.mapFile.create({
      data: {
        eventId: manualCtx.eventId,
        fileName: "manual.ocd",
        fileData: buf,
        rotationCorrection: 4.5,
        northDetection: legacyDetection(1.7),
        scale: shifted.scale,
        bounds: shifted.bounds as unknown as Prisma.InputJsonValue,
        northOffset: shifted.northOffset,
        calibration: shifted.calibration as unknown as Prisma.InputJsonValue,
        renderKey: "reset-manual-key",
      },
    });
    await manualCtx.db.mapTile.create({
      data: {
        renderKey: "reset-manual-key",
        z: 3,
        x: 1,
        y: 1,
        tileData: Buffer.from([1]),
      },
    });

    // Club-library rows: one auto, one manual.
    const clubAuto = await db.clubMapFile.create({
      data: {
        name: `Reset auto ${autoCtx.eventId}`,
        fileName: "club-auto.ocd",
        fileData: buf,
        sizeBytes: buf.length,
        rotationCorrection: 1.7,
        northDetection: legacyDetection(1.7),
        northOffset: 1.7,
      },
    });
    const clubManual = await db.clubMapFile.create({
      data: {
        name: `Reset manual ${autoCtx.eventId}`,
        fileName: "club-manual.ocd",
        fileData: buf,
        sizeBytes: buf.length,
        rotationCorrection: 4.5,
        northDetection: legacyDetection(1.7),
        northOffset: 4.5,
      },
    });
    clubIds.push(clubAuto.id, clubManual.id);

    // Same way prisma migrate deploy runs it: one statement at a time.
    const statements = migrationStatements();
    expect(statements.length).toBe(4);
    for (const sql of statements) await db.$executeRawUnsafe(sql);

    const autoAfter = await db.mapFile.findUniqueOrThrow({ where: { id: autoRow.id } });
    expect(autoAfter.rotationCorrection).toBe(0);
    expect(autoAfter.scale).toBeNull();
    expect(autoAfter.bounds).toBeNull();
    expect(autoAfter.northOffset).toBeNull();
    expect(autoAfter.calibration).toBeNull();
    expect(autoAfter.uploadedAt.getTime()).toBeGreaterThan(autoRow.uploadedAt.getTime());
    expect(autoAfter.northDetection).toMatchObject({ autoCorrectionResetFromDeg: 1.7 });
    expect(await db.mapTile.count({ where: { renderKey: "reset-auto-key" } })).toBe(0);

    const manualAfter = await manualCtx.db.mapFile.findUniqueOrThrow({
      where: { id: manualRow.id },
    });
    expect(manualAfter.rotationCorrection).toBe(4.5);
    expect(manualAfter.scale).toBe(shifted.scale);
    expect(manualAfter.calibration).not.toBeNull();
    expect(
      await manualCtx.db.mapTile.count({ where: { renderKey: "reset-manual-key" } }),
    ).toBe(1);

    const clubAutoAfter = await db.clubMapFile.findUniqueOrThrow({ where: { id: clubAuto.id } });
    expect(clubAutoAfter.rotationCorrection).toBe(0);
    expect(clubAutoAfter.northOffset).toBeNull();
    const clubManualAfter = await db.clubMapFile.findUniqueOrThrow({
      where: { id: clubManual.id },
    });
    expect(clubManualAfter.rotationCorrection).toBe(4.5);
    expect(clubManualAfter.northOffset).toBe(4.5);

    // First read re-derives metadata with correction 0 and re-syncs the
    // control's lat/lng to the file's own georeference.
    const caller = makeCaller(autoCtx.event);
    const meta = await caller.course.mapMetadata();
    const clean = await parseOcadMapMetadata(buf, 0);
    expect(meta!.rotationCorrection).toBe(0);
    expect(meta!.bounds.north).toBeCloseTo(clean.bounds!.north, 9);
    expect(meta!.northOffset).toBeCloseTo(clean.northOffset!, 9);
    expect(meta!.bounds.north).not.toBeCloseTo(shifted.bounds!.north, 6);

    const crs = await loadEventCrs(db, autoCtx.eventId);
    const expected = mapMmToWgs84(12, 8, crs!)!;
    const synced = await db.control.findUniqueOrThrow({
      where: { id: control.id },
      select: { lat: true, lng: true },
    });
    expect(synced.lat).toBeCloseTo(expected.lat, 8);
    expect(synced.lng).toBeCloseTo(expected.lng, 8);
  });
});
