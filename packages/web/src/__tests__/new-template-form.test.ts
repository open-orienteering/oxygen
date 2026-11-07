import { describe, expect, it } from "vitest";
import { EMPTY_TEMPLATE_DRAFT, newTemplatePayload } from "../lib/course-map-types";

describe("newTemplatePayload (E-pages: New template)", () => {
  it("a blank name takes the key's name", () => {
    const p = newTemplatePayload({ ...EMPTY_TEMPLATE_DRAFT, paper: "A3", orientation: "landscape", printScale: "10000" });
    expect(p).toMatchObject({ name: "A3 landscape 1:10000", paper: "A3", orientation: "landscape", printScale: 10000, objects: [] });
    expect(p.settings.mapFrame.width).toBeGreaterThan(p.settings.mapFrame.height);
  });

  it("a given name is kept, trimmed", () => {
    expect(newTemplatePayload({ ...EMPTY_TEMPLATE_DRAFT, name: "  Sprint  " }).name).toBe("Sprint");
  });
});
