/** Course objects (course-layer.md §8): the stored shape, scope, and the kinds onto the 7xx symbols. */

import { describe, expect, it } from "vitest";
import { courseLayer } from "../layer.js";
import { courseObjectAttachSchemaOf, courseObjectBodySchema, courseObjectInScope, courseObjectScopeSchemaOf, objectsInScope, resolveAttached, type CourseLayerObject, type StoredCourseObject } from "../objects.js";
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

describe("courseObjectBodySchema: opacity, blend, rotation, flip (J4, §8.1)", () => {
  const style = { opacity: 0.5, blend: "multiply" };
  it("takes opacity and blend on text, image and white-out; rotation on text and image; flips on image", () => {
    expect(issues({ kind: "text", geometry: [{ x: 1, y: 2 }], props: { text: "x", fontSizeMm: 3, ...style, rotationDeg: 30 } })).toEqual([]);
    expect(issues({ kind: "image", geometry: SQUARE.slice(0, 2), props: { graphicId: 3, ...style, rotationDeg: -90, flipH: true, flipV: false } })).toEqual([]);
    expect(issues({ kind: "whiteout", geometry: SQUARE, props: { opacity: 0 } })).toEqual([]);
    expect(issues({ kind: "whiteout", geometry: SQUARE, props: style })).toEqual([]);
  });

  it("refuses them elsewhere, out of range, an unknown blend and rotation on a white-out", () => {
    for (const [kind, geometry] of [["oob_area", SQUARE], ["oob_line", SQUARE], ["marked_route", SQUARE], ["toner_saver", SQUARE], ["inset_frame", SQUARE]] as const) {
      expect(issues({ kind, geometry, props: { opacity: 0.5 } }), kind).not.toEqual([]);
      expect(issues({ kind, geometry, props: { blend: "multiply" } }), kind).not.toEqual([]);
    }
    expect(issues({ kind: "filter_region", geometry: SQUARE, props: { mode: "hide", symbols: "all", opacity: 0.5 } })).not.toEqual([]);
    expect(issues({ kind: "whiteout", geometry: SQUARE, props: { rotationDeg: 10 } })).not.toEqual([]);
    expect(issues({ kind: "whiteout", geometry: SQUARE, props: { opacity: 1.5 } })).not.toEqual([]);
    expect(issues({ kind: "whiteout", geometry: SQUARE, props: { opacity: -0.1 } })).not.toEqual([]);
    expect(issues({ kind: "whiteout", geometry: SQUARE, props: { blend: "screen" } })).not.toEqual([]);
    expect(issues({ kind: "text", geometry: [{ x: 1, y: 2 }], props: { text: "x", fontSizeMm: 3, rotationDeg: 400 } })).not.toEqual([]);
    expect(issues({ kind: "image", geometry: SQUARE.slice(0, 2), props: { graphicId: 3, flipH: "yes" } })).not.toEqual([]);
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
    expect(img.own).toHaveLength(1);
    expect(img.own[0].image).toEqual({ graphicId: 9 });
    expect([...img.own[0].path.coords]).toEqual([2000, 4000, 10000, 4000, 10000, 8000, 2000, 8000]);
    expect(img.layer.images).toEqual([{ graphicId: 9, sizeUm: [8000, 4000] }]);

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

  it("opacity and blend reach a white-out's and a text's render object, only off their defaults (J4)", () => {
    const w = draw([obj({ kind: "whiteout", geometry: SQUARE, props: { opacity: 0.5, blend: "multiply" } })]);
    expect(w.own[0]).toMatchObject({ opacity: 0.5, blend: "multiply" });
    const opaque = draw([obj({ kind: "whiteout", geometry: SQUARE, props: { opacity: 1 } })]);
    expect("opacity" in opaque.own[0]).toBe(false);
    expect("blend" in opaque.own[0]).toBe(false);
    // Bit-identical to an object without the fields.
    expect(opaque.own).toEqual(draw([obj({ kind: "whiteout", geometry: SQUARE, props: {} })]).own);
    const t = draw([obj({ kind: "text", geometry: [{ x: 3, y: 4 }], props: { text: "x", fontSizeMm: 3, opacity: 0.25 } })]);
    expect(t.own[0].opacity).toBe(0.25);
  });

  it("a rotated text turns about its anchor: angleDeg is the clockwise rotation negated; 0 and whole turns are none (J4)", () => {
    const text = (rotationDeg?: number) =>
      draw([obj({ kind: "text", geometry: [{ x: 3, y: 4 }], props: { text: "x", fontSizeMm: 3, ...(rotationDeg === undefined ? {} : { rotationDeg }) } })]).own[0];
    expect(text(30).angleDeg).toBe(-30);
    expect([...text(30).path.coords]).toEqual([3000, 4000]);
    expect(text(0)).toEqual(text());
    expect(text(360)).toEqual(text());
    expect("angleDeg" in text()).toBe(false);
  });

  it("an image's opacity and blend go on its render object, rotation and flips into its corner order (J4, J5)", () => {
    const corners = (props: Record<string, unknown>) => {
      const o = draw([obj({ kind: "image", geometry: [{ x: 0, y: 0 }, { x: 20, y: 10 }], props: { graphicId: 9, ...props } } as never)]).own[0];
      return { o, pts: [...o.path.coords].map((v) => v / 1000) };
    };
    const { o } = corners({ opacity: 0.4, blend: "multiply" });
    expect(o).toMatchObject({ opacity: 0.4, blend: "multiply" });
    // Bottom-left, bottom-right, top-right, top-left of the visible part.
    expect(corners({}).pts).toEqual([0, 0, 20, 0, 20, 10, 0, 10]);
    expect(corners({ flipH: true }).pts).toEqual([20, 0, 0, 0, 0, 10, 20, 10]);
    expect(corners({ flipV: true }).pts).toEqual([0, 10, 20, 10, 20, 0, 0, 0]);
    expect(corners({ flipH: true, flipV: true }).pts).toEqual([20, 10, 0, 10, 0, 0, 20, 0]);
    // 90° clockwise about the centre (10, 5): the image's bottom-left goes to the top-left corner of the turned box.
    expect(corners({ rotationDeg: 90 }).pts).toEqual([5, 15, 5, -5, 15, -5, 15, 15]);
    const plain = corners({ opacity: 1, rotationDeg: 0, flipH: false }).o;
    expect("opacity" in plain || "blend" in plain).toBe(false);
  });
});

describe("attachment (J10, docs/course-layer.md §8.1)", () => {
  const o = { id: 1, kind: "oob_line" as const, geometry: [{ x: 0, y: 0, hOut: { x: 1, y: 2 } }, { x: 5, y: 0 }], props: {} };
  it("the schema takes a control and the position it was at", () => {
    const s = courseObjectAttachSchemaOf(z.number().int());
    expect(s.safeParse({ controlId: 31, at: { x: 1, y: 2 } }).success).toBe(true);
    expect(s.safeParse({ controlId: 31 }).success).toBe(false);
    expect(s.safeParse({ controlId: 31, at: { x: 1, y: 2 }, extra: 1 }).success).toBe(false);
  });
  it("resolveAttached translates by site − at keeping handles, drops one whose site is not drawn, returns an unattached list itself", () => {
    const sites = [{ id: "31", x: 10, y: 20 }];
    const [moved] = resolveAttached([{ ...o, attach: { controlId: 31, at: { x: 7, y: 17 } } }], sites);
    expect(moved.geometry).toEqual([{ x: 3, y: 3, hOut: { x: 1, y: 2 } }, { x: 8, y: 3 }]);
    expect("attach" in moved).toBe(false);
    expect(resolveAttached([{ ...o, attach: { controlId: 32, at: { x: 0, y: 0 } } }], sites)).toEqual([]);
    const list = [o];
    expect(resolveAttached(list, sites)).toBe(list);
  });
});
