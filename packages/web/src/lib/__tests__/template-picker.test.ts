import { describe, expect, it } from "vitest";
import { freeTemplateName, parsePick, pickValue } from "../template-picker";

describe("template picker (E-pages: the Courses page's one picker)", () => {
  it("round-trips the three kinds of pick through the <select> value", () => {
    for (const p of [{ kind: "template", seq: 4 }, { kind: "club", id: "12" }, { kind: "new" }] as const) {
      expect(parsePick(pickValue(p))).toEqual(p);
    }
    expect(pickValue({ kind: "template", seq: 4 })).toBe("4");
  });

  it("anything else is no pick", () => {
    for (const v of ["", "0", "-1", "x", "club:", "club:x", "1.5"]) expect(parsePick(v)).toBeNull();
  });

  it("a club template brought in takes a free name: base, base (2), …", () => {
    expect(freeTemplateName("Sprint", [])).toBe("Sprint");
    expect(freeTemplateName("Sprint", ["Sprint"])).toBe("Sprint (2)");
    expect(freeTemplateName("Sprint", ["Sprint", "Sprint (2)"])).toBe("Sprint (3)");
  });
});
