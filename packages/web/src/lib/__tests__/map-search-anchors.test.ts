import { describe, expect, it } from "vitest";
import {
  createCourseMapAnchors,
  type CourseMapSearchRow,
} from "../structured-search/anchors/course-map-anchors";
import {
  createMapTemplateAnchors,
  type MapTemplateSearchRow,
} from "../structured-search/anchors/map-template-anchors";

const label = (key: string) => key;

describe("map structured-search anchors", () => {
  it("filters course maps by status, class and template", () => {
    const row: CourseMapSearchRow = {
      id: 1,
      name: "Long",
      classNames: ["H40"],
      templateNames: ["A4"],
      status: "issues",
      mapCount: 2,
    };
    const anchors = createCourseMapAnchors(label, ["A4"]);
    expect(anchors.find((anchor) => anchor.key === "class")!.match(row, "contains", "h40")).toBe(true);
    expect(anchors.find((anchor) => anchor.key === "template")!.match(row, "eq", "A4")).toBe(true);
    expect(anchors.find((anchor) => anchor.key === "status")!.match(row, "eq", "issues")).toBe(true);
  });

  it("filters templates by paper, scale and usage", () => {
    const row: MapTemplateSearchRow = {
      name: "A4 standard",
      paper: "A4",
      orientation: "portrait",
      printScale: 7500,
      usedBy: 3,
    };
    const anchors = createMapTemplateAnchors(label);
    expect(anchors.find((anchor) => anchor.key === "paper")!.match(row, "eq", "A4")).toBe(true);
    expect(anchors.find((anchor) => anchor.key === "scale")!.match(row, "gte", "7500")).toBe(true);
    expect(anchors.find((anchor) => anchor.key === "used")!.match(row, "gt", "2")).toBe(true);
  });
});
