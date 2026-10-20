import { describe, expect, it } from "vitest";
import { COORD_FLAG, makePath } from "../pass-stream.js";
import { PathMeasure } from "../measure.js";
import { placeGlyphs } from "../placement.js";

const F = COORD_FLAG;
const line = (len: number) => new PathMeasure(makePath([0, 0, len, 0]));
const lens = (p: { len: number }[]) => p.map((x) => Math.round(x.len * 1000) / 1000);

describe("placeGlyphs — spaced", () => {
  it("spreads spots between first and last at the nearest count", () => {
    const p = placeGlyphs(line(10000), { at: "spaced", distanceUm: 2000, firstUm: 1000, lastUm: 1000 }, { rotatable: true });
    expect(lens(p)).toEqual([1000, 3000, 5000, 7000, 9000]);
    expect(p.every((x) => x.angleDeg === 0 && x.scale === 1)).toBe(true);
  });
  it("defaults first/last to half the distance and stretches to fit", () => {
    // inner = 11000 − 2000 = 9000 → n = round(4.5) + 1 = 6 (round half up) → step 1800.
    expect(lens(placeGlyphs(line(11000), { at: "spaced", distanceUm: 2000 }, { rotatable: false }))).toEqual([1000, 2800, 4600, 6400, 8200, 10000]);
  });
  it("centres a single spot and honours minCount", () => {
    expect(lens(placeGlyphs(line(2500), { at: "spaced", distanceUm: 2000, firstUm: 1000, lastUm: 1000 }, { rotatable: false }))).toEqual([1250]);
    // Shorter than first + last: nothing, unless minCount asks for a centred glyph.
    expect(placeGlyphs(line(1000), { at: "spaced", distanceUm: 2000 }, { rotatable: false })).toEqual([]);
    expect(lens(placeGlyphs(line(1000), { at: "spaced", distanceUm: 2000, minCount: 1 }, { rotatable: false }))).toEqual([500]);
  });
  it("places perSpot glyphs symmetrically around each spot", () => {
    const p = placeGlyphs(line(10000), { at: "spaced", distanceUm: 5000, firstUm: 2500, lastUm: 2500, perSpot: 2, spotSpacingUm: 400 }, { rotatable: false });
    expect(lens(p)).toEqual([2300, 2700, 7300, 7700]);
  });
  it("restarts at corner points but not at dash points", () => {
    const m = new PathMeasure(makePath([0, 0, 10000, 0, 20000, 0], [0, F.corner, 0]));
    expect(lens(placeGlyphs(m, { at: "spaced", distanceUm: 2000, firstUm: 1000, lastUm: 1000 }, { rotatable: false }))).toEqual([
      1000, 3000, 5000, 7000, 9000, 11000, 13000, 15000, 17000, 19000,
    ]);
    const d = new PathMeasure(makePath([0, 0, 10000, 0, 20000, 0], [0, F.dash, 0]));
    expect(lens(placeGlyphs(d, { at: "spaced", distanceUm: 20000, firstUm: 0, lastUm: 0 }, { rotatable: false }))).toEqual([0, 20000]);
  });
  it("on a closed loop spots are evenly spaced from the start point", () => {
    const sq = new PathMeasure(makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], undefined, true));
    expect(lens(placeGlyphs(sq, { at: "spaced", distanceUm: 1000 }, { rotatable: false }))).toEqual([0, 1000, 2000, 3000]);
    expect(placeGlyphs(sq, { at: "spaced", distanceUm: 10000, minCountClosed: 2 }, { rotatable: false })).toHaveLength(2);
  });
  it("follows the tangent when rotatable", () => {
    const m = new PathMeasure(makePath([0, 0, 0, 10000]));
    const p = placeGlyphs(m, { at: "spaced", distanceUm: 5000 }, { rotatable: true });
    expect(p.map((x) => x.angleDeg)).toEqual([90, 90]);
  });
});

describe("placeGlyphs — start, end, corners, dash points", () => {
  const bent = new PathMeasure(makePath([0, 0, 1000, 0, 1000, 1000], [0, F.corner, 0]));

  it("start and end sit on the ends with the tangent angle", () => {
    expect(placeGlyphs(bent, { at: "start" }, { rotatable: true })).toEqual([{ len: 0, angleDeg: 0, scale: 1 }]);
    expect(placeGlyphs(bent, { at: "end" }, { rotatable: true })).toEqual([{ len: 2000, angleDeg: 90, scale: 1 }]);
  });
  it("corner glyphs take the bisector angle, optionally scaled by the mitre", () => {
    const p = placeGlyphs(bent, { at: "corners", ignoreEnds: true }, { rotatable: true });
    expect(lens(p)).toEqual([1000]);
    expect(p[0].angleDeg).toBeCloseTo(45);
    expect(p[0].scale).toBe(1);
    const s = placeGlyphs(bent, { at: "corners", ignoreEnds: true }, { rotatable: true, scaleAtCorners: true });
    expect(s[0].scale).toBeCloseTo(Math.SQRT2);
  });
  it("includes the ends unless ignoreEnds", () => {
    expect(lens(placeGlyphs(bent, { at: "corners" }, { rotatable: false }))).toEqual([0, 1000, 2000]);
  });
  it("dash points are a separate flag", () => {
    const m = new PathMeasure(makePath([0, 0, 1000, 0, 2000, 0, 3000, 0], [0, F.corner, F.dash, 0]));
    expect(lens(placeGlyphs(m, { at: "dashPoints", ignoreEnds: true }, { rotatable: false }))).toEqual([2000]);
  });
  it("closed paths get a corner glyph at the start point only when it is flagged", () => {
    const sq = (f0: number) => new PathMeasure(makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], [f0, F.corner, 0, 0], true));
    expect(lens(placeGlyphs(sq(0), { at: "corners" }, { rotatable: false }))).toEqual([1000]);
    expect(lens(placeGlyphs(sq(F.corner), { at: "corners" }, { rotatable: false }))).toEqual([1000, 0]);
  });
});

describe("placeGlyphs — dash engine placements", () => {
  const dash = { layout: "ocad" as const, dashUm: 2000, gapUm: 500, endDashUm: 1000 };

  it("gapCentres puts one glyph in the middle of each gap", () => {
    const p = placeGlyphs(line(20000), { at: "gapCentres" }, { rotatable: false, dash });
    expect(lens(p)).toEqual([1250, 3750, 6250, 8750, 11250, 13750, 16250, 18750]);
  });
  it("dashCentres puts one glyph in the middle of each dash", () => {
    const p = placeGlyphs(line(20000), { at: "dashCentres" }, { rotatable: false, dash });
    expect(lens(p)).toEqual([500, 2500, 5000, 7500, 10000, 12500, 15000, 17500, 19500]);
  });
  it("needs a dash pattern", () => {
    expect(placeGlyphs(line(20000), { at: "gapCentres" }, { rotatable: false })).toEqual([]);
    expect(placeGlyphs(line(20000), { at: "dashGroupCentres" }, { rotatable: false })).toEqual([]);
  });
  it("dashGroupCentres sits in the secondary gap of each split dash (517 ruined fence)", () => {
    // Touching 1000 µm dashes, cut by a 200 µm secondary gap; end dashes stay whole and get no glyph.
    const split = { layout: "ocad" as const, dashUm: 1000, gapUm: 0, secondaryGapUm: 200 };
    expect(lens(placeGlyphs(line(8000), { at: "dashGroupCentres" }, { rotatable: false, dash: split }))).toEqual([1500, 2500, 3500, 4500, 5500, 6500]);
    // With an end gap (507 footpath) the end dashes are cut too.
    expect(lens(placeGlyphs(line(8000), { at: "dashGroupCentres" }, { rotatable: false, dash: { ...split, endGapUm: 200 } }))).toEqual([
      500, 1500, 2500, 3500, 4500, 5500, 6500, 7500,
    ]);
    // Without any split it degrades to dash centres.
    const plain = { layout: "ocad" as const, dashUm: 1000, gapUm: 1000 };
    expect(lens(placeGlyphs(line(8000), { at: "dashGroupCentres" }, { rotatable: false, dash: plain }))).toEqual(
      lens(placeGlyphs(line(8000), { at: "dashCentres" }, { rotatable: false, dash: plain })),
    );
  });
  it("sectionCentres puts one glyph in the middle of each corner-delimited section", () => {
    expect(lens(placeGlyphs(line(20000), { at: "sectionCentres" }, { rotatable: false }))).toEqual([10000]);
    const m = new PathMeasure(makePath([0, 0, 10000, 0, 20000, 0], [0, F.corner, 0]));
    expect(lens(placeGlyphs(m, { at: "sectionCentres" }, { rotatable: false }))).toEqual([5000, 15000]);
  });
});

describe("placeGlyphs — dash points centre a dash", () => {
  const dash = { layout: "ocad" as const, dashUm: 2000, gapUm: 500 };
  it("dashCentres puts exactly one glyph on a dash point", () => {
    const m = new PathMeasure(makePath([0, 0, 10000, 0, 16000, 0], [0, F.dash, 0]));
    const p = lens(placeGlyphs(m, { at: "dashCentres" }, { rotatable: false, dash }));
    // Second section (Es 1000, Ee 2000, n 2, r 1): the point itself, then 12500 and 15000.
    expect(p.filter((l) => Math.abs(l - 10000) < 1)).toHaveLength(1);
    expect(p.slice(-3).map(Math.round)).toEqual([10000, 12500, 15000]);
    expect(p).toHaveLength(4 + 3);
  });
  it("on a closed loop the seam dash is centred on the start point, once", () => {
    const sq = new PathMeasure(makePath([0, 0, 2500, 0, 2500, 2500, 0, 2500], undefined, true));
    const p = lens(placeGlyphs(sq, { at: "dashCentres" }, { rotatable: false, dash }));
    // L = 10000, n = 4 gaps → 4 dashes, centres every 2500 from the start point.
    expect(p.map(Math.round)).toEqual([0, 2500, 5000, 7500]);
    expect(lens(placeGlyphs(sq, { at: "gapCentres" }, { rotatable: false, dash })).map(Math.round)).toEqual([1250, 3750, 6250, 8750]);
  });
});

