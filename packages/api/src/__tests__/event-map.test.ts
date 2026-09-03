import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseOcadMapMetadata } from "../event-map.js";
import { isReservedEventSlug, sanitizeNameId } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../e2e/test.ocd");

describe("parseOcadMapMetadata", () => {
  it("returns nulls for a corrupt buffer instead of throwing", async () => {
    const meta = await parseOcadMapMetadata(Buffer.from("not-an-ocad-file"));
    expect(meta).toEqual({
      scale: null,
      bounds: null,
      northOffset: null,
      calibration: null,
    });
  });

  it("extracts scale, bounds, north offset and calibration from a real map", async () => {
    const meta = await parseOcadMapMetadata(readFileSync(FIXTURE));
    expect(meta.scale).toBeGreaterThan(0);
    expect(meta.bounds).toBeTruthy();
    expect(meta.bounds!.north).toBeGreaterThan(meta.bounds!.south);
    expect(meta.northOffset).not.toBeNull();

    // Calibration: map-mm ↔ WGS84 anchor points covering the map corners,
    // enough for the client to build an affine transform with no controls.
    expect(meta.calibration).toBeTruthy();
    expect(meta.calibration!.length).toBeGreaterThanOrEqual(3);
    for (const p of meta.calibration!) {
      expect(Number.isFinite(p.mapX)).toBe(true);
      expect(Number.isFinite(p.mapY)).toBe(true);
      expect(p.lat).toBeGreaterThanOrEqual(meta.bounds!.south - 1e-6);
      expect(p.lat).toBeLessThanOrEqual(meta.bounds!.north + 1e-6);
      expect(p.lng).toBeGreaterThanOrEqual(meta.bounds!.west - 1e-6);
      expect(p.lng).toBeLessThanOrEqual(meta.bounds!.east + 1e-6);
    }
    // The corners must span an area, not collapse to a point.
    const xs = meta.calibration!.map((p) => p.mapX);
    const ys = meta.calibration!.map((p) => p.mapY);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1);
  });
});

describe("reserved event slugs", () => {
  it("blocks the top-level UI routes after sanitization", () => {
    expect(isReservedEventSlug(sanitizeNameId("library"))).toBe(true);
    expect(isReservedEventSlug(sanitizeNameId("admin"))).toBe(true);
    expect(isReservedEventSlug(sanitizeNameId("settings"))).toBe(true);
    expect(isReservedEventSlug(sanitizeNameId("Library"))).toBe(true);
    expect(isReservedEventSlug(sanitizeNameId("Settings"))).toBe(true);
    expect(isReservedEventSlug(sanitizeNameId("itest"))).toBe(false);
  });
});
