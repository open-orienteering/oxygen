import { describe, expect, it } from "vitest";
import { exportEntries } from "../export-menu";

const base = { nameId: "my event", courseSeq: 3, classSeq: null, sheetSeq: null, canEdit: true };

describe("exportEntries (course-layout.md §7)", () => {
  it("lists the phase-1 entries on the existing routes", () => {
    const e = exportEntries(base);
    expect(e.map((x) => x.id)).toEqual(["sheet", "course", "class", "all", "allControls", "iofxml", "ppen"]);
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
});
