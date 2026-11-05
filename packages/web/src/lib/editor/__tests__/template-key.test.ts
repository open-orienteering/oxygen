import { describe, expect, it } from "vitest";
import { extraTemplateName, moveOutTarget, templateCourses, type SheetRow, type TemplateRow } from "../template-key";

const auto: TemplateRow = { seq: 1, name: "A4 portrait 1:10000", autoKey: "A4-portrait-10000", isExtra: false };
const extra: TemplateRow = { seq: 2, name: "Sprint", autoKey: "A4-portrait-10000", isExtra: true };
const other: TemplateRow = { seq: 3, name: "A3", autoKey: "A3-portrait-10000", isExtra: false };
const sheet = (course: number, name: string, t: TemplateRow, cls: number | null = null): SheetRow => ({
  kind: "course", courseId: course, course: { seq: course, name }, class: cls === null ? null : { seq: cls }, template: { seq: t.seq, autoKey: t.autoKey },
});

describe("templateCourses (course-layout.md §5)", () => {
  const sheets = [sheet(1, "Blå", auto), sheet(1, "Blå", auto), sheet(2, "Röd", extra), sheet(3, "Lång", other), sheet(4, "Grön", extra, 9), sheet(4, "Grön", auto)];

  it("lists the courses in a template and the others at its key, once each, class sheets aside", () => {
    expect(templateCourses(sheets, auto)).toEqual({
      inTemplate: [{ seq: 1, name: "Blå", templateSeq: 1 }, { seq: 4, name: "Grön", templateSeq: 1 }],
      others: [{ seq: 2, name: "Röd", templateSeq: 2 }],
    });
    expect(templateCourses(sheets, extra).inTemplate.map((c) => c.name)).toEqual(["Röd"]);
    expect(templateCourses(sheets, other)).toEqual({ inTemplate: [{ seq: 3, name: "Lång", templateSeq: 3 }], others: [] });
  });
});

describe("moveOutTarget", () => {
  it("goes to the key's auto template, or from the auto one to an extra; none without another", () => {
    expect(moveOutTarget([auto, extra, other], extra)).toBe(1);
    expect(moveOutTarget([auto, extra, other], auto)).toBe(2);
    expect(moveOutTarget([auto, extra, other], other)).toBeNull();
  });
});

describe("extraTemplateName", () => {
  it("is free among the event's names", () => {
    expect(extraTemplateName("A4", new Set())).toBe("A4 (extra)");
    expect(extraTemplateName("A4", new Set(["A4 (extra)", "A4 (extra 2)"]))).toBe("A4 (extra 3)");
  });
});
