import { describe, expect, it } from "vitest";
import { layoutEditorHref } from "../layout-href";

// The Maps and Map templates pages' *Edit layout* is this link and nothing
// else since E4c deleted the legacy layout editor (docs/course-layout.md §4).
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
