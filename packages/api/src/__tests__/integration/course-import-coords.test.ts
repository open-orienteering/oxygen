/**
 * Regression integration test for OCD course import → control coords.
 *
 * Symptom that motivated this test: after re-importing courses from
 * an OCD bundle, controls in the map view either disappeared
 * (Vinterserien) or showed up without leg lines (Bagissprinten).
 *
 * Two root causes:
 *   1. `ocd-course-parser` only knows map-mm coords and emits
 *      `lat: 0, lng: 0` for every control. `importCourses` used to
 *      write those zeros straight through, so the next read sent
 *      controls to (0°, 0°) — they vanished off the map.
 *   2. A re-import would unconditionally overwrite a previously-good
 *      lat/lng with new zeros from the parser.
 *
 * Fix: `importCourses` now resolves the CRS from the uploaded OCAD
 * file (or the supplied ocdBase64) and converts each control to
 * WGS84 up front; on update we only write lat/lng when we have a
 * real, non-zero pair.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";

const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let ocdBase64: string;

beforeAll(async () => {
  ctx = await createTestEvent("course_import_coords");
  caller = makeCaller(ctx.event);
  ocdBase64 = readFileSync(FIXTURE).toString("base64");
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
  await disconnect();
}, 30_000);

describe("course.importCourses — OCD coordinate conversion", () => {
  it("resolves WGS84 lat/lng for controls on first import", async () => {
    const res = await caller.course.importCourses({ ocdBase64 });
    expect(res.controlsCreated).toBeGreaterThan(0);

    const controls = await caller.course.controlCoordinates();
    expect(controls.length).toBeGreaterThan(0);

    // The whole point of the bug: at least most controls must have a
    // real, non-zero lat/lng — not be plotted at (0, 0).
    const nonZero = controls.filter(
      (c) => Math.abs(c.lat) > 0.0001 && Math.abs(c.lng) > 0.0001,
    );
    expect(nonZero.length).toBeGreaterThan(controls.length * 0.5);

    // Map-mm coordinates also round-trip.
    const haveMapMm = controls.filter(
      (c) => c.mapX !== 0 || c.mapY !== 0,
    );
    expect(haveMapMm.length).toBeGreaterThan(0);
  });

  it("preserves the resolved lat/lng on a second (re-)import", async () => {
    // Snapshot the coordinates after the first import.
    const before = await caller.course.controlCoordinates();
    const beforeById = new Map(before.map((c) => [c.id, { lat: c.lat, lng: c.lng }]));

    // Re-import the same OCD bundle. Without the fix, this clobbers
    // every control's lat/lng back to 0.
    await caller.course.importCourses({ ocdBase64 });
    const after = await caller.course.controlCoordinates();

    // Same controls, same coordinates within rounding noise.
    expect(after.length).toBe(before.length);
    for (const c of after) {
      const prev = beforeById.get(c.id);
      expect(prev).toBeDefined();
      if (!prev) continue;
      expect(c.lat).toBeCloseTo(prev.lat, 5);
      expect(c.lng).toBeCloseTo(prev.lng, 5);
    }

    // And none of them collapsed back to the equator.
    const collapsed = after.filter(
      (c) => Math.abs(c.lat) < 0.0001 && Math.abs(c.lng) < 0.0001,
    );
    expect(collapsed.length).toBe(0);
  });

  it("populates the controls string on course.list (for fallback leg renderer)", async () => {
    const courses = await caller.course.list();
    expect(courses.length).toBeGreaterThan(0);
    // At least one course must expose its control sequence as a
    // non-empty `;`-joined string. The web `MapPanel` fallback
    // renderer uses this to draw leg lines for non-highlighted
    // courses.
    const withControls = courses.filter((c) => c.controls.length > 0);
    expect(withControls.length).toBeGreaterThan(0);
    for (const c of withControls) {
      const tokens = c.controls.split(";").filter(Boolean);
      expect(tokens.length).toBe(c.controlCount);
      for (const t of tokens) {
        expect(t).toMatch(/^\d+$/);
      }
    }
  });

  it("bumps map_files.uploaded_at so tile cache busts after course import", async () => {
    // Seed a map_files row so we have something to bump.
    const buf = readFileSync(FIXTURE);
    await ctx.db.mapFile.deleteMany({ where: { eventId: ctx.eventId } });
    await ctx.db.mapFile.create({
      data: {
        eventId: ctx.eventId,
        fileName: "test.ocd",
        fileData: buf,
      },
    });
    const before = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.eventId },
      select: { uploadedAt: true },
    });

    // Wait a millisecond so the timestamps definitely differ.
    await new Promise((r) => setTimeout(r, 20));
    await caller.course.importCourses({ ocdBase64 });

    const after = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.eventId },
      select: { uploadedAt: true },
    });
    expect(after?.uploadedAt.getTime()).toBeGreaterThan(
      before!.uploadedAt.getTime(),
    );
  });
});
