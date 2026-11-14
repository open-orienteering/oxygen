import { describe, expect, it } from "vitest";
import { S, mapped, ring, syntheticDoc } from "../graph/__tests__/synthetic.js";
import { tick } from "../solve/__tests__/fixtures.js";
import { decodeHeightField, encodeHeightField, sampleHeight, type HeightFieldProvider } from "../field/index.js";
import { deriveAnchoredTerrain, deriveTerrain, type AnchoredDem } from "../index.js";

// The hill of derive.test.ts: four rings around (30, 30), 5 mm apart (75 m at 1:15 000).
const HILL = mapped([...[5, 10, 15, 20].map((r) => ({ sym: S.contour, coords: ring(30, 30, r, 96) })), tick(50, 30, 1, 0)]);
const I = 5;
const BASE = 402.6; // the 20 mm ring; the model is a cone through every ring at its own level
const cone = (cx: number) => (x: number, y: number) => BASE + (I * (20 - Math.hypot(x - cx, y - 30))) / 5;
const LM: HeightFieldProvider = { id: "lantmateriet-2m", resolutionM: 2, grade: "anchor", licence: "CC BY 4.0", attribution: "© Lantmäteriet", verticalDatum: "RH 2000" };
const dem = (over: Partial<AnchoredDem> = {}): AnchoredDem => ({ sample: cone(30), grade: "anchor", demCellM: 2, providerId: "lantmateriet-2m", provider: LM, ...over });

describe("deriveAnchoredTerrain (map-terrain.md §4.9, §7.5)", () => {
  it("re-derives the hill at the DEM's absolute heights", () => {
    const t = deriveAnchoredTerrain(syntheticDoc(HILL), dem());
    if (!t) throw new Error("no terrain");
    expect(t.field.header).toMatchObject({ datum: "absolute", source: "contours.lantmateriet-2m", provider: LM, zOffsetM: 400, intervalM: I });
    expect(t.acceptedOfCovered).toBeGreaterThan(0.95);
    expect(t.anchor.source).toBe("lantmateriet-2m");
    expect(t.heights.share.dem).toBeGreaterThan(0.95);
    expect(t.report.share.decided).toBeGreaterThan(0.99);
    for (const d of [7.5, 12.5, 17.5]) expect(Math.abs(sampleHeight(t.field, { x: 30 + d, y: 30 })! - cone(30)(30 + d, 30))).toBeLessThan(0.1 * I);
  });

  it("keeps the shape of the relative field on the same grid", () => {
    const doc = syntheticDoc(HILL);
    const rel = deriveTerrain(doc)!.field.header, abs = deriveAnchoredTerrain(doc, dem())!.field.header;
    expect({ cellMm: abs.cellMm, x0: abs.x0, y0: abs.y0, width: abs.width, height: abs.height }).toEqual({ cellMm: rel.cellMm, x0: rel.x0, y0: rel.y0, width: rel.width, height: rel.height });
  });

  it("reports a DEM that does not line up with the contours (the misalignment gate's input)", () => {
    const t = deriveAnchoredTerrain(syntheticDoc(HILL), dem({ sample: cone(45) }))!;
    expect(t.acceptedOfCovered).toBeLessThan(0.5);
  });

  it("takes a coarse model's confidence from the contours, not the DEM", () => {
    const t = deriveAnchoredTerrain(syntheticDoc(HILL), dem({ grade: "coarse", demCellM: 30, providerId: "glo30-30m", provider: { ...LM, id: "glo30-30m", grade: "coarse", resolutionM: 30 } }))!;
    expect(t.field.header).toMatchObject({ datum: "absolute", source: "contours.glo30-30m" });
    expect(t.anchor.grade).toBe("coarse");
  });

  it("is null without contours, and deterministic to the byte", () => {
    expect(deriveAnchoredTerrain(syntheticDoc(mapped([], [0, 0, 10, 10])), dem())).toBeNull();
    const a = encodeHeightField(deriveAnchoredTerrain(syntheticDoc(HILL), dem())!.field);
    expect(a).toEqual(encodeHeightField(decodeHeightField(encodeHeightField(deriveAnchoredTerrain(syntheticDoc(HILL), dem())!.field))));
  });
});
