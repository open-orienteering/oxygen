import { describe, expect, it } from "vitest";
import { layoutEditorHref, retiredPageHref } from "../layout-href";

// The Courses page's *Edit layout* is this link (docs/course-layout.md §4);
// the Maps and Map templates pages redirect (E-pages).
describe("layoutEditorHref", () => {
  it("opens a sheet in Layout mode with its course", () => {
    expect(layoutEditorHref("my-event", { sheet: 7 }, 3)).toBe("/my-event/course-editor?mode=layout&sheet=7&course=3");
  });

  it("opens a template, previewed with a course when one is given", () => {
    expect(layoutEditorHref("my-event", { template: 2 })).toBe("/my-event/course-editor?mode=layout&template=2");
    expect(layoutEditorHref("my-event", { template: 2 }, 5)).toBe("/my-event/course-editor?mode=layout&template=2&course=5");
  });

  it("omits a null course (the all-controls sheet) and encodes the event name", () => {
    expect(layoutEditorHref("vår cup/1", { sheet: 1 }, null)).toBe("/v%C3%A5r%20cup%2F1/course-editor?mode=layout&sheet=1");
  });
});

describe("retiredPageHref (E-pages: /maps and /map-templates redirect)", () => {
  it("/maps goes to the Courses page with its query (?course= opens the course)", () => {
    expect(retiredPageHref("my-event", "maps", "?course=4")).toBe("/my-event/courses?course=4");
    expect(retiredPageHref("my-event", "maps", "")).toBe("/my-event/courses");
  });

  it("/map-templates goes to Layout mode, on the template when ?template= names one", () => {
    expect(retiredPageHref("my-event", "map-templates", "?template=2")).toBe("/my-event/course-editor?mode=layout&template=2");
    expect(retiredPageHref("my-event", "map-templates", "")).toBe("/my-event/course-editor?mode=layout");
    expect(retiredPageHref("my-event", "map-templates", "?template=x")).toBe("/my-event/course-editor?mode=layout");
  });
});
