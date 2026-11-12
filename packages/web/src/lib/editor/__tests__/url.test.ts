import { describe, expect, it } from "vitest";
import { editorSearchFor, parseEditorUrl, type EditorUrlState } from "../url";

// The editor's URL (docs/course-editor.md §1 "URL"; F31).
const BASE: EditorUrlState = { course: null, mode: null, view: "course", classSeq: null, variantKey: null, layout: null };
const state = (s: Partial<EditorUrlState>): EditorUrlState => ({ ...BASE, ...s });
const strip = ({ control: _c, invalid: _i, ...rest }: ReturnType<typeof parseEditorUrl>): EditorUrlState => rest;

describe("editorSearchFor", () => {
  it("omits every default: no course, Course mode, Course view", () => {
    expect(editorSearchFor(BASE)).toBe("");
    expect(editorSearchFor(state({ mode: "course" }))).toBe("");
  });

  it("writes the params in a fixed order", () => {
    expect(editorSearchFor(state({ course: 3, mode: "layout", layout: { sheet: 7 } }))).toBe("course=3&mode=layout&sheet=7");
    expect(editorSearchFor(state({ course: 3, view: "class", classSeq: 5 }))).toBe("course=3&view=class&class=5");
    expect(editorSearchFor(state({ course: 3, view: "variant", variantKey: "AC" }))).toBe("course=3&view=variant&variant=AC");
    expect(editorSearchFor(state({ course: 3, view: "all-variations" }))).toBe("course=3&view=all-variations");
    expect(editorSearchFor(state({ mode: "field", view: "all" }))).toBe("mode=field&view=all");
    expect(editorSearchFor(state({ mode: "layout", layout: { template: 2 } }))).toBe("mode=layout&template=2");
  });

  it("writes Class view's and Layout's variant (F8), and no stray class or layout", () => {
    expect(editorSearchFor(state({ course: 1, view: "class", classSeq: 2, variantKey: "B" }))).toBe("course=1&view=class&class=2&variant=B");
    expect(editorSearchFor(state({ course: 1, mode: "layout", variantKey: "B", layout: { sheet: 4 } }))).toBe("course=1&mode=layout&variant=B&sheet=4");
    expect(editorSearchFor(state({ course: 1, view: "all", classSeq: 2, variantKey: "B" }))).toBe("course=1&view=all");
    expect(editorSearchFor(state({ course: 1, mode: "course", layout: { sheet: 4 } }))).toBe("course=1");
  });

  it("drops control and every other editor param, and keeps params it does not own", () => {
    expect(editorSearchFor(state({ course: 2 }), "control=9&mode=bogus&sheet=3&foo=bar")).toBe("course=2&foo=bar");
  });
});

describe("parseEditorUrl", () => {
  it("round-trips every state it writes", () => {
    const states: EditorUrlState[] = [
      BASE,
      state({ course: 3 }),
      state({ course: 3, mode: "layout", layout: { sheet: 7 } }),
      state({ mode: "layout", layout: { template: 2 } }),
      state({ course: 3, mode: "layout", variantKey: "AB", layout: { sheet: 7 } }),
      state({ course: 3, mode: "field", view: "all" }),
      state({ course: 3, view: "class", classSeq: 5 }),
      state({ course: 3, view: "class", classSeq: 5, variantKey: "BA" }),
      state({ course: 3, view: "variant", variantKey: "AC" }),
      state({ course: 3, view: "all-variations" }),
    ];
    for (const s of states) {
      const parsed = parseEditorUrl(editorSearchFor(s));
      expect(parsed.invalid).toEqual([]);
      expect(strip(parsed)).toEqual(s);
    }
  });

  it("reads the inbound control link, which is never written back", () => {
    const p = parseEditorUrl("?control=12");
    expect(p.control).toBe(12);
    expect(p.invalid).toEqual([]);
    expect(editorSearchFor(strip(p))).toBe("");
  });

  it("reads the Courses page's links and layoutEditorHref's", () => {
    expect(strip(parseEditorUrl("course=4"))).toEqual(state({ course: 4 }));
    expect(strip(parseEditorUrl("mode=layout&sheet=7&course=3"))).toEqual(state({ course: 3, mode: "layout", layout: { sheet: 7 } }));
    expect(strip(parseEditorUrl("mode=layout&template=2"))).toEqual(state({ mode: "layout", layout: { template: 2 } }));
    expect(parseEditorUrl("mode=course").mode).toBe("course");
  });

  it("drops a value that is not a positive integer: course, control, class, sheet, template", () => {
    for (const bad of ["0", "-1", "abc", "1.5", "", "01", "9999999999"]) {
      const p = parseEditorUrl(`course=${bad}&control=${bad}&view=class&class=${bad}&mode=layout&sheet=${bad}`);
      expect(p.course).toBeNull();
      expect(p.control).toBeNull();
      expect(p.classSeq).toBeNull();
      expect(p.layout).toBeNull();
      expect(p.invalid).toEqual(expect.arrayContaining(["course", "control", "class", "sheet", "view"]));
      expect(parseEditorUrl(`mode=layout&template=${bad}`).invalid).toEqual(["template"]);
    }
  });

  it("drops an unknown mode and view", () => {
    const p = parseEditorUrl("mode=bogus&view=nope&course=2");
    expect(p.mode).toBeNull();
    expect(p.view).toBe("course");
    expect(p.course).toBe(2);
    expect(p.invalid).toEqual(["mode", "view"]);
  });

  it("drops Class view without its class, and a class without Class view", () => {
    expect(parseEditorUrl("view=class")).toMatchObject({ view: "course", classSeq: null, invalid: ["view"] });
    expect(parseEditorUrl("view=all&class=3")).toMatchObject({ view: "all", classSeq: null, invalid: ["class"] });
  });

  it("drops Variant view without its key, and a key where no view or mode draws one", () => {
    expect(parseEditorUrl("view=variant")).toMatchObject({ view: "course", variantKey: null, invalid: ["view"] });
    expect(parseEditorUrl("view=variant&variant=a%20b")).toMatchObject({ view: "course", variantKey: null, invalid: ["variant", "view"] });
    expect(parseEditorUrl("variant=AC")).toMatchObject({ view: "course", variantKey: null, invalid: ["variant"] });
    expect(parseEditorUrl("view=all&variant=AC").invalid).toEqual(["variant"]);
  });

  it("drops a sheet or template outside Layout mode, and a template beside a sheet", () => {
    expect(parseEditorUrl("sheet=3")).toMatchObject({ layout: null, invalid: ["sheet"] });
    expect(parseEditorUrl("mode=field&template=3")).toMatchObject({ layout: null, invalid: ["template"] });
    expect(parseEditorUrl("mode=layout&sheet=3&template=4")).toMatchObject({ layout: { sheet: 3 }, invalid: ["template"] });
  });

  it("is what the cleaned URL says: an invalid param is gone from the next write", () => {
    const p = parseEditorUrl("course=2&mode=bogus&view=class&sheet=3&control=x");
    expect(editorSearchFor(strip(p))).toBe("course=2");
  });
});
