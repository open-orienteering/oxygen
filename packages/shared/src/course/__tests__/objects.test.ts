/** Course objects (course-layer.md §8): the stored shape, scope, and the kinds onto the 7xx symbols. */

import { describe, expect, it } from "vitest";
import { courseLayer } from "../layer.js";
import { courseObjectBodySchema, courseObjectInScope, courseObjectScopeSchemaOf, objectsInScope, type CourseLayerObject, type StoredCourseObject } from "../objects.js";
import { COORD_FLAG } from "../../render/pass-stream.js";
import { layerInput } from "./helpers.js";
import { z } from "zod";

const SQUARE = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
const obj = (o: Omit<CourseLayerObject, "id"> & { id?: number | string }): CourseLayerObject => ({ id: 1, ...o }) as CourseLayerObject;
const issues = (v: unknown) => {
  const r = courseObjectBodySchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("courseObjectBodySchema (§8.1)", () => {
  it("accepts each phase-1 kind with its geometry and props", () => {
    const ok = [
      { kind: "oob_area", geometry: SQUARE, props: { border: "dashed" } },
      { kind: "oob_area", geometry: SQUARE, props: {} },
      { kind: "oob_area", geometry: SQUARE, props: { hatch: "710", border: "solid" } },
      { kind: "oob_line", geometry: SQUARE.slice(0, 2), props: { symbol: "711" } },
      { kind: "whiteout", geometry: SQUARE, props: {} },
      { kind: "toner_saver", geometry: SQUARE, props: { marginMm: 5, holeRadiusMm: 4 } },
      { kind: "marked_route", geometry: [{ x: 0, y: 0, hOut: { x: 1, y: 1 } }, { x: 5, y: 5 }], props: {} },
      { kind: "text", geometry: [{ x: 1, y: 2 }], props: { text: "Ingen passage", fontSizeMm: 3 } },
      { kind: "image", geometry: [{ x: 0, y: 0 }, { x: 10, y: 5 }], props: { graphicId: 3 } },
      { kind: "filter_region", geometry: SQUARE, props: { mode: "hide", symbols: [4, 5], invert: true } },
      { kind: "filter_region", geometry: SQUARE, props: { mode: "clip", symbols: { colours: [2] } } },
      { kind: "inset_frame", geometry: SQUARE.slice(0, 2), props: {} },
    ];
    for (const o of ok) expect(issues(o), o.kind).toEqual([]);
  });

  it("refuses short geometry per kind, unknown props and bad filter props", () => {
    expect(issues({ kind: "oob_area", geometry: SQUARE.slice(0, 2), props: {} }).join()).toMatch(/OBJECT_GEOMETRY/);
    expect(issues({ kind: "oob_line", geometry: SQUARE.slice(0, 1), props: {} }).join()).toMatch(/OBJECT_GEOMETRY/);
    expect(issues({ kind: "text", geometry: SQUARE.slice(0, 2), props: { text: "x", fontSizeMm: 3 } }).join()).toMatch(/OBJECT_GEOMETRY/);
    expect(issues({ kind: "image", geometry: SQUARE.slice(0, 1), props: { graphicId: 1 } }).join()).toMatch(/OBJECT_GEOMETRY/);
    expect(issues({ kind: "oob_area", geometry: SQUARE, props: { crossSpacingMm: 2 } })).not.toEqual([]);
    expect(issues({ kind: "oob_area", geometry: SQUARE, props: { hatch: "711" } })).not.toEqual([]);
    expect(issues({ kind: "oob_line", geometry: SQUARE, props: { widthMm: 0.5 } })).not.toEqual([]);
    expect(issues({ kind: "filter_region", geometry: SQUARE, props: { mode: "blur", symbols: "all" } })).not.toEqual([]);
    expect(issues({ kind: "filter_region", geometry: SQUARE, props: { mode: "hide", symbols: [-1] } })).not.toEqual([]);
    // A region is a polygon: Bézier handles are refused, not dropped.
    expect(issues({ kind: "filter_region", geometry: [{ x: 0, y: 0, hOut: { x: 1, y: 0 } }, ...SQUARE], props: { mode: "hide", symbols: "all" } })).not.toEqual([]);
    expect(issues({ kind: "banner", geometry: SQUARE, props: {} })).not.toEqual([]);
  });
});

describe("courseObjectInScope (§8.2)", () => {
  const scope = courseObjectScopeSchemaOf(z.number().int());
  it("parses both scope forms and nothing else", () => {
    expect(scope.safeParse({ all: true }).success).toBe(true);
    expect(scope.safeParse({ courses: [1], classes: [] }).success).toBe(true);
    expect(scope.safeParse({ all: false }).success).toBe(false);
    expect(scope.safeParse({ courses: [1] }).success).toBe(false);
  });

  it("all → everywhere; a course or a class running it → that course; all-controls → all only", () => {
    const drawn = { courses: [1], classes: [7] };
    expect(courseObjectInScope({ all: true }, drawn)).toBe(true);
    expect(courseObjectInScope({ all: true }, null)).toBe(true);
    expect(courseObjectInScope({ courses: [1], classes: [] }, drawn)).toBe(true);
    expect(courseObjectInScope({ courses: [2], classes: [] }, drawn)).toBe(false);
    expect(courseObjectInScope({ courses: [], classes: [7] }, drawn)).toBe(true);
    expect(courseObjectInScope({ courses: [], classes: [8] }, drawn)).toBe(false);
    expect(courseObjectInScope({ courses: [1], classes: [7] }, null)).toBe(false);
    // A parked object (both lists empty) is drawn nowhere.
    expect(courseObjectInScope({ courses: [], classes: [] }, drawn)).toBe(false);
  });
});

describe("objectsInScope (stored rows, UUID scope; §8.2)", () => {
  const row = (seq: number, scope: StoredCourseObject["scope"]): StoredCourseObject =>
    ({ id: `u${seq}`, seq, scope, z: 0, version: 0n, kind: "text", geometry: { type: "Point", coordinates: [0, 0] }, props: { text: "x" } }) as unknown as StoredCourseObject;
  const objects = [row(1, { all: true }), row(2, { courses: ["A"], classes: [] }), row(3, { courses: [], classes: ["k"] }), row(4, { courses: ["B"], classes: [] })];
  const byCourse = new Map([["A", ["k"]]]);

  it("a course takes its own, its classes' and the all-scoped rows; no course the all-scoped only", () => {
    expect(objectsInScope(objects, "A", byCourse).map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(objectsInScope(objects, "B", byCourse).map((o) => o.seq)).toEqual([1, 4]);
    expect(objectsInScope(objects, null, byCourse).map((o) => o.seq)).toEqual([1]);
  });
});

describe("course objects in the layer (§8.3)", () => {
  const draw = (objects: CourseLayerObject[], view = {}) => {
    const layer = courseLayer(layerInput({ structure: null, objects, viewOptions: view }));
    return { layer, own: layer.objects.filter((o) => o.ref.kind === "object") };
  };
  const symbolId = (layer: ReturnType<typeof courseLayer>, i: number) => layer.symbols[i].id;

  it("oob_area → 709 / 709.b / 709.c by border, the dangerous area's cross-hatch with hatch 710; oob_line → 708 / 711; marked_route → 707; whiteout → upper white", () => {
    const cases: [CourseLayerObject, string][] = [
      [obj({ kind: "oob_area", geometry: SQUARE, props: {} }), ":709"],
      [obj({ kind: "oob_area", geometry: SQUARE, props: { border: "solid" } }), ":709.b"],
      [obj({ kind: "oob_area", geometry: SQUARE, props: { border: "dashed" } }), ":709.c"],
      [obj({ kind: "oob_area", geometry: SQUARE, props: { hatch: "709" } }), ":709"],
      [obj({ kind: "oob_area", geometry: SQUARE, props: { hatch: "710" } }), "course:dangerous"],
      [obj({ kind: "oob_area", geometry: SQUARE, props: { hatch: "710", border: "solid" } }), "course:dangerous.b"],
      [obj({ kind: "oob_area", geometry: SQUARE, props: { hatch: "710", border: "dashed" } }), "course:dangerous.c"],
      [obj({ kind: "oob_line", geometry: SQUARE.slice(0, 2), props: {} }), ":708"],
      [obj({ kind: "oob_line", geometry: SQUARE.slice(0, 2), props: { symbol: "711" } }), ":711"],
      [obj({ kind: "marked_route", geometry: SQUARE.slice(0, 3), props: {} }), ":707"],
      [obj({ kind: "whiteout", geometry: SQUARE, props: {} }), "course:whiteout"],
    ];
    for (const [o, id] of cases) {
      const { layer, own } = draw([o]);
      expect(own, o.kind).toHaveLength(1);
      expect(symbolId(layer, own[0].symbolIdx).endsWith(id), `${o.kind} ${symbolId(layer, own[0].symbolIdx)}`).toBe(true);
      expect(own[0].ref.id).toBe("course-object:1");
      const closed = o.kind === "oob_area" || o.kind === "whiteout";
      expect(own[0].path.closed).toBe(closed);
    }
  });

  it("keeps Bézier handles of a marked route", () => {
    const { own } = draw([obj({ kind: "marked_route", geometry: [{ x: 0, y: 0, hOut: { x: 1, y: 2 } }, { x: 5, y: 5 }], props: {} })]);
    expect(own[0].path.coords).toHaveLength(8);
  });

  it("text: upper purple by default, an own row for an explicit colour; paper-mm size, not divided by the print enlargement", () => {
    const { layer, own } = draw([obj({ kind: "text", geometry: [{ x: 3, y: 4 }], props: { text: "{course}", fontSizeMm: 4 } })], { overprintScale: 2, textValues: { course: "Lång" } });
    expect(own).toHaveLength(1);
    expect(own[0].text).toBe("Lång");
    const sym = layer.symbols[own[0].symbolIdx];
    expect(sym.type).toBe("text");
    if (sym.type !== "text") return;
    expect(layer.colours[sym.colour].paletteIds).toContain("purple-upper");
    expect(sym.fontSizeUm).toBe(4000);
    const red = draw([obj({ kind: "text", geometry: [{ x: 3, y: 4 }], props: { text: "x", fontSizeMm: 2, color: "#ff0000" } })]);
    const redSym = red.layer.symbols[red.own[0].symbolIdx];
    expect(redSym.type === "text" && red.layer.colours[redSym.colour].id).toBe("course-object:#ff0000");
  });

  it("image → layer.images from two corners; toner saver needs the window; inset_frame and filter_region draw no object", () => {
    const img = draw([obj({ kind: "image", geometry: [{ x: 10, y: 8 }, { x: 2, y: 4 }], props: { graphicId: 9 } })]);
    expect(img.own).toHaveLength(0);
    expect(img.layer.images).toEqual([{ graphicId: 9, rectUm: { x: 2000, y: 4000, width: 8000, height: 4000 } }]);

    const toner = obj({ kind: "toner_saver", geometry: SQUARE, props: {} });
    expect(draw([toner]).own).toHaveLength(0);
    expect(draw([toner]).layer.warnings.map((w) => w.code)).toEqual(["WINDOW_MISSING"]);
    const window = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
    const framed = draw([toner], { window });
    expect(framed.own).toHaveLength(1);
    expect(framed.own[0].path.coords).toHaveLength(16);

    // A smooth toner saver (D13): the hull's handles reach the hole ring as Bézier flags, the frame ring stays straight.
    const round = obj({
      kind: "toner_saver",
      props: { marginMm: 25 },
      geometry: [
        { x: 20, y: 10, hOut: { x: 0, y: 5 } }, { x: 25, y: 15, hIn: { x: 5, y: 0 } },
        { x: 25, y: 25 }, { x: 15, y: 25 },
      ],
    });
    const smooth = draw([round], { window });
    expect(smooth.layer.warnings).toEqual([]);
    const { flags } = smooth.own[0].path;
    const bezier = COORD_FLAG.bezierFirst | COORD_FLAG.bezierSecond;
    expect(flags.slice(0, 4).every((f) => (f & bezier) === 0)).toBe(true);
    expect(flags.slice(4).filter((f) => f & COORD_FLAG.bezierFirst)).toHaveLength(1);
    expect(flags.slice(4).filter((f) => f & COORD_FLAG.bezierSecond)).toHaveLength(1);
    expect(flags[4] & COORD_FLAG.hole).toBeTruthy();

    expect(draw([obj({ kind: "inset_frame", geometry: SQUARE.slice(0, 2), props: {} })]).own).toHaveLength(0);
    const region = draw([obj({ kind: "filter_region", geometry: SQUARE, props: { mode: "hide", symbols: "all" } })]);
    expect(region.own).toHaveLength(0);
    expect(region.layer.regions).toHaveLength(1);
  });
});
