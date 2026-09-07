/**
 * Integration test for course.setMapRotation — persist a north/grivation
 * correction, re-derive map metadata, and clear tile caches.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;

beforeAll(async () => {
  ctx = await createTestEvent("map_rotation");
  caller = makeCaller(ctx.event);
  const buf = readFileSync(FIXTURE);
  await caller.course.uploadMap({
    fileName: "test.ocd",
    fileDataBase64: buf.toString("base64"),
  });
});

afterAll(async () => {
  await ctx.cleanup();
  await disconnect();
});

describe("course.setMapRotation", () => {
  it("stores the correction, re-derives metadata, and drops tiles", async () => {
    // Seed a fake cached tile so we can assert it gets deleted.
    await ctx.db.mapTile.create({
      data: {
        eventId: ctx.eventId,
        z: 12,
        x: 1,
        y: 1,
        tileData: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    });

    const before = await caller.course.mapMetadata();
    expect(before).not.toBeNull();
    expect(before!.rotationCorrection).toBe(0);

    const result = await caller.course.setMapRotation({ degrees: 11 });
    expect(result.success).toBe(true);
    expect(result.rotationCorrection).toBe(11);
    expect(result.northOffset).not.toBeNull();

    const expected = await parseOcadMapMetadata(readFileSync(FIXTURE), 11);
    expect(result.northOffset).toBeCloseTo(expected.northOffset!, 6);
    if (result.bounds && expected.bounds) {
      expect(result.bounds.north).toBeCloseTo(expected.bounds.north, 6);
      expect(result.bounds.west).toBeCloseTo(expected.bounds.west, 6);
    }

    const after = await caller.course.mapMetadata();
    expect(after!.rotationCorrection).toBe(11);
    expect(after!.northOffset).toBeCloseTo(expected.northOffset!, 6);

    const tiles = await ctx.db.mapTile.count({
      where: { eventId: ctx.eventId },
    });
    expect(tiles).toBe(0);

    // Reset to 0 should restore the uncorrected northOffset.
    const reset = await caller.course.setMapRotation({ degrees: 0 });
    expect(reset.rotationCorrection).toBe(0);
    const uncorrected = await parseOcadMapMetadata(readFileSync(FIXTURE), 0);
    expect(reset.northOffset).toBeCloseTo(uncorrected.northOffset!, 6);
  });

  it("rejects when no map is uploaded", async () => {
    const other = await createTestEvent("map_rotation_empty");
    const emptyCaller = makeCaller(other.event);
    await expect(
      emptyCaller.course.setMapRotation({ degrees: 5 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await other.cleanup();
  });
});
