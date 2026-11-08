import { describe, expect, it } from "vitest";
import { descriptionSheetsUrl, exportEntries } from "../export-menu";

const base = { nameId: "my event", courseSeq: 3, classSeq: null, sheetSeq: null, canEdit: true };

describe("exportEntries (course-layout.md §7)", () => {
  it("lists the phase-1 entries on the existing routes", () => {
    const e = exportEntries(base);
    expect(e.map((x) => x.id)).toEqual(["sheet", "course", "class", "all", "allControls", "setter", "descriptions", "iofxml", "ppen"]);
    const by = Object.fromEntries(e.map((x) => [x.id, x]));
    expect(by.course.url).toBe("/api/maps/my%20event/maps.pdf?courses=3");
    expect(by.all.url).toBe("/api/maps/my%20event/maps.pdf");
    expect(by.allControls.url).toBe("/api/maps/my%20event/maps.pdf?allControls=1");
    expect(by.iofxml.url).toBe("/api/export/course-data?name=my+event&format=iofxml");
    expect(by.ppen.url).toBe("/api/export/course-data?name=my+event&format=ppen");
  });

  it("ensures the sheets before a map export: the course's, or every course's", () => {
    const by = Object.fromEntries(exportEntries(base).map((x) => [x.id, x]));
    expect(by.course.ensure).toEqual({ courseId: 3 });
    expect(by.all.ensure).toEqual({});
    // The all-controls sheet is created on demand (E-pages).
    expect(by.allControls.ensure).toEqual({ allControls: true });
    expect(by.iofxml.ensure).toBeNull();
  });

  it("this sheet: Layout mode's shown sheet, as it is (E-pages)", () => {
    let by = Object.fromEntries(exportEntries(base).map((x) => [x.id, x]));
    expect(by.sheet.disabled).toBe(true);
    by = Object.fromEntries(exportEntries({ ...base, sheetSeq: 12 }).map((x) => [x.id, x]));
    expect(by.sheet).toMatchObject({ disabled: false, url: "/api/maps/my%20event/maps.pdf?maps=12", ensure: null });
  });

  it("this class needs Class view; this course a course", () => {
    let by = Object.fromEntries(exportEntries({ ...base, courseSeq: null }).map((x) => [x.id, x]));
    expect(by.course.disabled).toBe(true);
    expect(by.class.disabled).toBe(true);
    expect(by.all.disabled).toBe(false);
    by = Object.fromEntries(exportEntries({ ...base, classSeq: 9 }).map((x) => [x.id, x]));
    expect(by.class).toMatchObject({ disabled: false, url: "/api/maps/my%20event/maps.pdf?classes=9", ensure: { courseId: 3 } });
  });

  it("without courses.edit nothing is created first", () => {
    expect(exportEntries({ ...base, classSeq: 9, canEdit: false }).every((x) => x.ensure === null)).toBe(true);
  });

  it("description sheets open a dialog: nothing to ensure, never disabled (course-print.md §6.4)", () => {
    const by = Object.fromEntries(exportEntries({ ...base, courseSeq: null, canEdit: false }).map((x) => [x.id, x]));
    expect(by.descriptions).toMatchObject({ ensure: null, disabled: false, dialog: "descriptions" });
    expect(by.descriptions.url).toBe("/api/maps/my%20event/descriptions.pdf");
    expect(by.course.dialog).toBeUndefined();
  });

  it("setter maps: every setter sheet (`?setter=1`), nothing ensured, never disabled (course-layout.md §7, §8)", () => {
    for (const s of [base, { ...base, courseSeq: null, canEdit: false }]) {
      const by = Object.fromEntries(exportEntries(s).map((x) => [x.id, x]));
      expect(by.setter).toMatchObject({ url: "/api/maps/my%20event/maps.pdf?setter=1", ensure: null, disabled: false });
    }
  });
});

describe("descriptionSheetsUrl", () => {
  it("names the classes, the copies mode and the cell size", () => {
    expect(descriptionSheetsUrl("my event", { classSeqs: [4, 2], copies: "count", cell: 6 })).toBe("/api/maps/my%20event/descriptions.pdf?classes=4%2C2&copies=count&cell=6");
    expect(descriptionSheetsUrl("e", { classSeqs: [1], copies: "fill", cell: 5 })).toBe("/api/maps/e/descriptions.pdf?classes=1&copies=fill&cell=5");
    expect(descriptionSheetsUrl("e", { classSeqs: [1], copies: 12, cell: 7, gap: 3 })).toBe("/api/maps/e/descriptions.pdf?classes=1&copies=12&cell=7&gap=3");
  });
});
