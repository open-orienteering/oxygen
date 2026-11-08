import { describe, expect, it } from "vitest";
import { COURSE_FIT_MARGIN_MM, STANDARD_PRINT_SCALES, defaultTemplateSettings, fitOrientation, fitScale, pickAutoTemplate, templateAutoKey, templateKeyName } from "../course-maps/auto-template.js";

describe("templateAutoKey (course-layout.md §5)", () => {
  it("is paper-orientation-scale", () => {
    expect(templateAutoKey({ paper: "A4", orientation: "portrait", printScale: 10000 })).toBe("A4-portrait-10000");
    expect(templateAutoKey({ paper: "A3", orientation: "landscape", printScale: 7500 })).toBe("A3-landscape-7500");
  });

  it("names a custom paper's size, so two custom sizes never share a key", () => {
    const a = templateAutoKey({ paper: "custom", orientation: "portrait", printScale: 4000, paperWidthMm: 200, paperHeightMm: 300 });
    const b = templateAutoKey({ paper: "custom", orientation: "portrait", printScale: 4000, paperWidthMm: 210.2, paperHeightMm: 297 });
    expect(a).toBe("custom200x300-portrait-4000");
    expect(b).toBe("custom210x297-portrait-4000");
  });

  it("ignores the custom size for standard papers", () => {
    expect(templateAutoKey({ paper: "A5", orientation: "portrait", printScale: 5000, paperWidthMm: 1, paperHeightMm: 2 })).toBe("A5-portrait-5000");
  });

  it("names an auto template after its key", () => {
    expect(templateKeyName({ paper: "A4", orientation: "portrait", printScale: 10000 })).toBe("A4 portrait 1:10000");
    expect(templateKeyName({ paper: "custom", orientation: "landscape", printScale: 4000, paperWidthMm: 300, paperHeightMm: 200 })).toBe("300×200 mm landscape 1:4000");
  });
});

describe("pickAutoTemplate — decision (3)", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  const t1 = new Date("2026-02-01T00:00:00Z");

  it("picks the template with the most sheets", () => {
    expect(
      pickAutoTemplate([
        { id: "old", sheetCount: 1, createdAt: t0, seq: 1 },
        { id: "busy", sheetCount: 3, createdAt: t1, seq: 2 },
      ]),
    ).toBe("busy");
  });

  it("ties go to the oldest, then the lowest seq", () => {
    expect(
      pickAutoTemplate([
        { id: "new", sheetCount: 2, createdAt: t1, seq: 1 },
        { id: "old", sheetCount: 2, createdAt: t0, seq: 5 },
      ]),
    ).toBe("old");
    expect(
      pickAutoTemplate([
        { id: "b", sheetCount: 0, createdAt: t0, seq: 4 },
        { id: "a", sheetCount: 0, createdAt: t0, seq: 2 },
      ]),
    ).toBe("a");
  });

  it("is null without candidates", () => {
    expect(pickAutoTemplate([])).toBeNull();
  });
});

describe("fitOrientation — 08 §4.6 window defaults", () => {
  it("keeps the preferred orientation when the course fits", () => {
    expect(fitOrientation({ width: 100, height: 150 }, 1, "A4", "portrait", 3)).toBe("portrait");
    expect(fitOrientation({ width: 100, height: 150 }, 1, "A4", "landscape", 3)).toBe("landscape");
    expect(fitOrientation({ width: 100, height: 200 }, 1, "A4", "landscape", 3)).toBe("portrait");
  });

  it("turns the sheet when only the other orientation holds the course", () => {
    expect(fitOrientation({ width: 260, height: 150 }, 1, "A4", "portrait", 3)).toBe("landscape");
  });

  it("scales the extent to the print (ratio = map scale / print scale)", () => {
    // 150 mm wide at 1:10000 printed at 1:15000 → 100 mm: portrait fits.
    expect(fitOrientation({ width: 150 * 1.6, height: 100 }, 10000 / 15000, "A4", "portrait", 3)).toBe("portrait");
  });

  it("keeps the fit margin on every side", () => {
    const frameW = 210 - 6;
    expect(fitOrientation({ width: frameW - 2 * COURSE_FIT_MARGIN_MM, height: 100 }, 1, "A4", "portrait", 3)).toBe("portrait");
    expect(fitOrientation({ width: frameW - 2 * COURSE_FIT_MARGIN_MM + 1, height: 100 }, 1, "A4", "portrait", 3)).toBe("landscape");
  });

  it("takes the closer one when neither fits", () => {
    expect(fitOrientation({ width: 600, height: 300 }, 1, "A4", "portrait", 3)).toBe("landscape");
    expect(fitOrientation({ width: 300, height: 600 }, 1, "A4", "landscape", 3)).toBe("portrait");
  });
});

describe("fitScale — 08 §4.6 setter / all-controls recalculation (course-layout.md §8)", () => {
  // A4 portrait less a 3 mm margin: 204 × 291 mm; less the fit margin: 192 × 279 mm of course.
  const W = 210 - 6 - 2 * COURSE_FIT_MARGIN_MM;

  it("lists the standard scales 1:4 000 … 1:15 000, largest map first", () => {
    expect(STANDARD_PRINT_SCALES).toEqual([4000, 5000, 7500, 10000, 15000]);
  });

  it("takes the largest scale whose frame holds the extent with the margin", () => {
    // 100 × 100 map mm at 1:10 000 is 1 km square: 250 mm at 1:4 000, 200 at 1:5 000, 133 at 1:7 500.
    expect(fitScale({ width: 100, height: 100 }, 10000, "A4", "portrait", 3)).toEqual({ orientation: "portrait", printScale: 7500 });
    // A small group prints at 1:4 000.
    expect(fitScale({ width: 30, height: 20 }, 10000, "A4", "portrait", 3)).toEqual({ orientation: "portrait", printScale: 4000 });
  });

  it("turns the sheet before taking a smaller scale", () => {
    // 270 × 150 mm at 1:10 000: at 1:10 000 only landscape (279 mm wide) holds it.
    expect(fitScale({ width: 270, height: 150 }, 10000, "A4", "portrait", 3)).toEqual({ orientation: "landscape", printScale: 10000 });
  });

  it("counts the margin on every side", () => {
    // Exactly W wide at 1:4 000 (a 1:4 000 map) fits portrait; a millimetre more goes landscape.
    expect(fitScale({ width: W, height: 100 }, 4000, "A4", "portrait", 3)).toEqual({ orientation: "portrait", printScale: 4000 });
    expect(fitScale({ width: W + 1, height: 100 }, 4000, "A4", "portrait", 3)).toEqual({ orientation: "landscape", printScale: 4000 });
  });

  it("falls back to 1:15 000 in the closer orientation when nothing fits", () => {
    expect(fitScale({ width: 2000, height: 900 }, 10000, "A4", "portrait", 3)).toEqual({ orientation: "landscape", printScale: 15000 });
  });

  it("an empty extent (one control) takes the largest scale in the preferred orientation", () => {
    expect(fitScale({ width: 0, height: 0 }, 15000, "A4", "landscape", 3)).toEqual({ orientation: "landscape", printScale: 4000 });
  });
});

describe("defaultTemplateSettings", () => {
  it("frames inside the margin and puts the block top right", () => {
    const s = defaultTemplateSettings({ width: 210, height: 297 }, 5);
    expect(s.mapFrame).toEqual({ x: 5, y: 5, width: 200, height: 287 });
    expect(s.description).toMatchObject({ visible: true, x: 157, y: 9, cellSizeMm: 6 });
  });
});
