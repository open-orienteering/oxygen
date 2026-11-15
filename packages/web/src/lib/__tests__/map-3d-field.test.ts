import { describe, expect, it } from "vitest";
import { HEIGHT_NO_DATA, isConfident, sampleHeight } from "@oxygen/shared/src/terrain/field/read.js";
import { coarsenFactor, coarsenField, padFieldToBounds, viewerField } from "../map-3d-field";
import { coneField, fieldFromGrid, CONE } from "../../map-gl/terrain/synthetic";

describe("padFieldToBounds (map-rendering.md §5.4 \"3D mode\" decision 2)", () => {
  const field = coneField();
  const h = field.header;
  const ext = { minX: h.x0, minY: h.y0, maxX: h.x0 + h.width * h.cellMm, maxY: h.y0 + h.height * h.cellMm };

  it("grows by whole no-data cells on the same grid to cover the bounds", () => {
    const bounds = { minX: ext.minX - 3.05, minY: ext.minY - 1, maxX: ext.maxX + 0.5, maxY: ext.maxY + 2.01 };
    const p = padFieldToBounds(field, bounds);
    expect(p.header.x0).toBeLessThanOrEqual(bounds.minX + 1e-9);
    expect(p.header.y0).toBeLessThanOrEqual(bounds.minY + 1e-9);
    expect(p.header.x0 + p.header.width * p.header.cellMm).toBeGreaterThanOrEqual(bounds.maxX - 1e-9);
    expect(p.header.y0 + p.header.height * p.header.cellMm).toBeGreaterThanOrEqual(bounds.maxY - 1e-9);
    // on the grid: whole cells, less than one cell beyond each side
    const left = (h.x0 - p.header.x0) / h.cellMm;
    expect(Math.abs(left - Math.round(left))).toBeLessThan(1e-9);
    expect(bounds.minX - p.header.x0).toBeLessThan(h.cellMm);
    expect(p.header.width).toBe(h.width + 16 + 3);
    // padding is no-data, never confident
    expect(p.z[0]).toBe(HEIGHT_NO_DATA);
    expect(isConfident(p, 0)).toBe(false);
    expect([p.header.zMin, p.header.zMax]).toEqual([h.zMin, h.zMax]);
  });

  it("leaves sampleHeight unchanged inside the original extent (edges included)", () => {
    const p = padFieldToBounds(field, { minX: ext.minX - 5, minY: ext.minY - 5, maxX: ext.maxX + 5, maxY: ext.maxY + 5 });
    for (let k = 0; k <= 40; k++)
      for (const y of [ext.minY + 0.01, (ext.minY + ext.maxY) / 2, ext.maxY - 0.01]) {
        const pt = { x: ext.minX + 0.01 + ((ext.maxX - ext.minX - 0.02) * k) / 40, y };
        const a = sampleHeight(p, pt), b = sampleHeight(field, pt);
        expect(a === null).toBe(b === null);
        if (a !== null && b !== null) expect(a).toBeCloseTo(b, 9);
      }
    expect(sampleHeight(p, { x: ext.minX - 1, y: ext.minY + 1 })).toBeNull();
  });

  it("returns the field itself when it covers the bounds", () => {
    expect(padFieldToBounds(field, { minX: ext.minX + 1, minY: ext.minY + 1, maxX: ext.maxX - 1, maxY: ext.maxY - 1 })).toBe(field);
  });
});

describe("coarsenField (decision 3)", () => {
  it("averages each block's data cells and keeps the lower-left corner", () => {
    const f = fieldFromGrid(5, 4, (cx, cy) => (cx === 4 ? Number.NaN : cx + 10 * cy), { cellMm: 0.2, intervalM: 64 });
    const c = coarsenField(f, 2);
    expect([c.header.width, c.header.height, c.header.cellMm]).toEqual([3, 2, 0.4]);
    expect([c.header.x0, c.header.y0]).toEqual([f.header.x0, f.header.y0]);
    // zScaleM = 1: the heights are the metres
    expect(c.z[0]).toBe(Math.round((0 + 1 + 10 + 11) / 4));
    // the last column's blocks are only no-data (more than half): no-data
    expect(c.z[2]).toBe(HEIGHT_NO_DATA);
    expect(c.header.zMin).toBe(Math.round(5.5));
    expect(c.header.zMax).toBe(Math.round((22 + 23 + 32 + 33) / 4));
    expect(coarsenField(f, 1)).toBe(f);
  });

  it("keeps a block's confidence when most of its data cells are confident", () => {
    const f = fieldFromGrid(2, 2, () => 5);
    f.confident.fill(0);
    f.confident[0] = 0b0111;
    expect(isConfident(coarsenField(f, 2), 0)).toBe(true);
    f.confident[0] = 0b0011;
    expect(isConfident(coarsenField(f, 2), 0)).toBe(false);
  });
});

describe("viewerField: within a third of the budget and the texture limit", () => {
  it("the smallest whole factor", () => {
    expect(coarsenFactor(1000, 1000, 5_000_000, 4096)).toBe(1);
    expect(coarsenFactor(1000, 1000, 4_999_999, 4096)).toBe(2);
    expect(coarsenFactor(5000, 100, 1e12, 4096)).toBe(2);
  });

  it("pads, then coarsens a sprint-sized field under an event map's 30 MB", () => {
    const bounds = { minX: 0, minY: 0, maxX: 420, maxY: 297 };
    const small = coneField();
    // the cone in a club map's budget is padded only (161² + padding at 0.2 mm ≈ 3.1 M cells = 15.6 MB < 50 MB)
    const club = viewerField(small, bounds, 150 * 1024 * 1024, 16384);
    expect(club.header.cellMm).toBe(CONE.cellMm);
    expect(club.header.width * club.header.cellMm).toBeGreaterThanOrEqual(420);
    // an event map: 10 MB for the field → coarsened by 2
    const event = viewerField(small, bounds, 30 * 1024 * 1024, 16384);
    expect(event.header.cellMm).toBeCloseTo(CONE.cellMm * 2, 12);
    expect(event.header.width * event.header.height * 5).toBeLessThanOrEqual((30 * 1024 * 1024) / 3);
    // a 2048-texel device
    const phone = viewerField(small, bounds, 150 * 1024 * 1024, 1024);
    expect(Math.max(phone.header.width, phone.header.height)).toBeLessThanOrEqual(1024);
  });
});
