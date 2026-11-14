/** Advisory course checks (course-layer.md §9): one fixture per code. */

import { describe, expect, it } from "vitest";
import { COURSE_CHECK_CODES, OOB_CODES, UNCROSSABLE_CODES, checkObstaclesOfDocument, courseChecks, invertedCode, type CheckObstacle, type CheckSite, type CheckVariationGroup, type CourseChecksInput } from "../checks.js";
import { COORD_FLAG } from "../../render/pass-stream.js";
import { OBJECT_TYPE, applyPatch, decodeMapDocument, encodeMapDocument, mapPatchSchema, type MapDocumentInput } from "../../map-document/index.js";
import { getSymbolLibrary, SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";
import type { CourseDerivation, CourseStructure } from "../types.js";
import type { CourseLayerObject } from "../objects.js";
import type { PathVertex } from "../../course-maps/schema.js";

const S = (id: string, x: number, y: number, over: Partial<CheckSite> = {}): CheckSite => ({
  id, code: id, codes: /^\d+$/.test(id) ? [Number(id)] : [], kind: "control", x, y, description: { d: `1.${id}` }, ...over,
});

/** At 1:10 000 one paper mm is 10 m: 31 → 32 is 100 m, 32 → 33 50 m. */
const SITES: CheckSite[] = [
  S("S1", 0, 0.5, { kind: "start", description: null }),
  S("31", 10, 0),
  S("32", 20, 0),
  S("33", 25, 0),
  S("F1", 35, 0, { kind: "finish", description: null }),
];
const course = (ids = ["S1", "31", "32", "33", "F1"], over: Partial<CourseStructure> = {}): CourseStructure => ({
  version: 1, id: "c", orderMode: "ordered", items: ids.map((siteId) => ({ siteId })), ...over,
});
const run = (over: Partial<CourseChecksInput> = {}) =>
  courseChecks({ structure: course(), sites: SITES, document: null, sheets: null, mapScale: 10000, ...over });
const codes = (over: Partial<CourseChecksInput> = {}) => run(over).map((c) => c.code);

describe("a clean course", () => {
  it("has no findings", () => {
    expect(run()).toEqual([]);
  });
});

describe("CONTROL_TOO_CLOSE", () => {
  const close = [...SITES, S("34", 22.5, 0, { description: { d: "1.x" } })]; // 25 m from 32 and 33
  it("flags distinct controls closer than 30 m, one check per pair, at the midpoint", () => {
    const found = run({ sites: close }).filter((c) => c.code === "CONTROL_TOO_CLOSE");
    expect(found.map((c) => c.siteIds)).toEqual([["32", "34"], ["33", "34"]]);
    expect(found[0].at).toEqual({ x: 21.25, y: 0 });
    expect(found[0].params).toEqual({ a: "32", b: "34", distanceM: 25, limitM: 30 });
  });
  it("uses 15 m at sprint scale: the document's library, else a 1:5 000 map", () => {
    const sprint = { libraryId: "ISSprOM2019-2" as const, obstacles: [] };
    expect(codes({ sites: close, document: sprint, mapScale: 10000 })).not.toContain("CONTROL_TOO_CLOSE");
    expect(codes({ sites: [...SITES, S("34", 21.2, 0, { description: { d: "1.x" } })], document: sprint, mapScale: 10000 })).toContain("CONTROL_TOO_CLOSE"); // 12 m
    // 32 → 33 is 5 mm: 25 m at 1:5 000 (sprint, clear), 30 m at 1:6 000 (clear), 4 mm 24 m at 1:6 000 (flagged).
    expect(codes({ mapScale: 5000 })).not.toContain("CONTROL_TOO_CLOSE");
    expect(codes({ sites: SITES.map((s) => (s.id === "33" ? { ...s, x: 24 } : s)), mapScale: 5000 })).not.toContain("CONTROL_TOO_CLOSE");
    expect(codes({ sites: SITES.map((s) => (s.id === "33" ? { ...s, x: 24 } : s)), mapScale: 6000 })).toContain("CONTROL_TOO_CLOSE");
  });
  it("ignores start, finish and unpositioned sites, and needs a scale", () => {
    expect(codes({ sites: [...SITES, S("S2", 10.5, 0, { kind: "start", description: null }), S("40", 0, 0)] })).not.toContain("CONTROL_TOO_CLOSE");
    expect(codes({ sites: close, mapScale: null })).not.toContain("CONTROL_TOO_CLOSE");
  });
  it("is event-wide: a site no course visits counts", () => {
    expect(codes({ sites: close, structure: null })).toContain("CONTROL_TOO_CLOSE");
  });
});

describe("SAME_FEATURE_TOO_CLOSE", () => {
  it("flags the same column D within 60 m", () => {
    const sites = SITES.map((s) => (s.id === "33" ? { ...s, description: { d: "1.32" } } : s));
    const found = run({ sites }).filter((c) => c.code === "SAME_FEATURE_TOO_CLOSE");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ siteIds: ["32", "33"], params: { distanceM: 50, limitM: 60, feature: "1.32" } });
    expect(codes({ sites, mapScale: 15000 })).not.toContain("SAME_FEATURE_TOO_CLOSE"); // 75 m
  });
});

describe("codes", () => {
  it("CODE_BELOW_31 for a control's punch code < 31", () => {
    const found = run({ sites: [...SITES, S("x", 50, 50, { codes: [30] })] }).filter((c) => c.code === "CODE_BELOW_31");
    expect(found).toEqual([{ code: "CODE_BELOW_31", siteIds: ["x"], at: { x: 50, y: 50 }, params: { code: 30 } }]);
    expect(codes({ sites: [...SITES, S("y", 50, 50, { codes: [1], kind: "start" })] })).not.toContain("CODE_BELOW_31");
  });
  it("CODE_DUPLICATE for a code on two sites", () => {
    const found = run({ sites: [...SITES, S("dup", 60, 60, { codes: [32] })] }).filter((c) => c.code === "CODE_DUPLICATE");
    expect(found).toEqual([{ code: "CODE_DUPLICATE", siteIds: ["32", "dup"], at: { x: 20, y: 0 }, params: { code: 32 } }]);
  });
  it("CODE_INVERTIBLE when both readings are in use, never for a self-symmetric code", () => {
    const sites = [...SITES, S("66", 60, 0), S("99", 80, 0), S("161", 100, 0), S("191", 120, 0), S("69", 140, 0), S("88", 160, 0)];
    const found = run({ sites }).filter((c) => c.code === "CODE_INVERTIBLE");
    expect(found.map((c) => c.params)).toEqual([{ a: 66, b: 99 }, { a: 161, b: 191 }]);
    expect(found[0].siteIds).toEqual(["66", "99"]);
    expect(codes({ sites: [...SITES, S("66", 60, 0)] })).not.toContain("CODE_INVERTIBLE");
  });
  it("reads codes upside down", () => {
    expect([66, 68, 86, 161, 69, 88, 181, 101, 60, 32, 47].map(invertedCode)).toEqual([99, 89, 98, 191, 69, 88, 181, 101, null, null, null]);
  });
});

describe("CONTROL_OUTSIDE_SHEET", () => {
  const sheet = { minX: -5, minY: -5, width: 32, height: 10 };
  it("flags a course site outside every sheet window, once per site", () => {
    const found = run({ sheets: [sheet] }).filter((c) => c.code === "CONTROL_OUTSIDE_SHEET");
    expect(found.map((c) => c.siteIds[0])).toEqual(["F1"]);
    expect(codes({ sheets: [sheet, { minX: 30, minY: -5, width: 10, height: 10 }] })).not.toContain("CONTROL_OUTSIDE_SHEET");
  });
  it("is skipped without sheets", () => {
    expect(codes({ sheets: [] })).not.toContain("CONTROL_OUTSIDE_SHEET");
    expect(codes({ sheets: null })).not.toContain("CONTROL_OUTSIDE_SHEET");
  });
});

describe("map exchange parts (§11, F5)", () => {
  // S1 → 31 → 32 (exchange) → 33 → F1: part 1 S1…32, part 2 32…F1.
  const sites = SITES.map((s) => (s.id === "32" ? { ...s, kind: "map_exchange" } : s));
  const part1 = { minX: -5, minY: -5, width: 28, height: 10, section: 0 };
  const part2 = { minX: 15, minY: -5, width: 25, height: 10, section: 1 };
  const exchangeRun = (over: Partial<CourseChecksInput> = {}) => run({ sites, ...over });

  it("EXCHANGE_WITHOUT_SHEET for a part with no sheet, at its exchange, after CONTROL_OUTSIDE_SHEET", () => {
    const found = exchangeRun({ sheets: [part1] });
    const missing = found.filter((c) => c.code === "EXCHANGE_WITHOUT_SHEET");
    expect(missing).toEqual([{ code: "EXCHANGE_WITHOUT_SHEET", siteIds: ["32"], at: { x: 20, y: 0 }, params: { part: 2, code: "32" } }]);
    // Part 2's controls lie outside part 1's window only.
    expect(found.filter((c) => c.code === "CONTROL_OUTSIDE_SHEET").map((c) => c.siteIds[0])).toEqual(["33", "F1"]);
    expect(found.map((c) => c.code).indexOf("EXCHANGE_WITHOUT_SHEET")).toBeGreaterThan(found.map((c) => c.code).lastIndexOf("CONTROL_OUTSIDE_SHEET"));
    expect(exchangeRun({ sheets: [part2] }).filter((c) => c.code === "EXCHANGE_WITHOUT_SHEET").map((c) => c.params)).toEqual([{ part: 1, code: "32" }]);
  });

  it("nothing when every part has a sheet, without sheets, or on a one-part course", () => {
    expect(exchangeRun({ sheets: [part1, part2] })).toEqual([]);
    expect(exchangeRun({ sheets: null })).toEqual([]);
    expect(exchangeRun({ sheets: [] })).toEqual([]);
    expect(codes({ sheets: [part1] })).not.toContain("EXCHANGE_WITHOUT_SHEET");
  });

  it("CONTROL_OUTSIDE_SHEET is per part: a control only inside another part's window is outside", () => {
    // 31 (x 10) lies only in a widened part-2 window; part 1's window misses it.
    const narrow1 = { ...part1, minX: 18, width: 5 };
    const wide2 = { ...part2, minX: 5, width: 35 };
    const found = exchangeRun({ sheets: [{ ...narrow1, minX: -5, width: 8 }, { ...narrow1 }, wide2] }).filter((c) => c.code === "CONTROL_OUTSIDE_SHEET");
    expect(found.map((c) => c.siteIds[0])).toEqual(["31"]);
  });

  it("a window without a section stands for every part", () => {
    const whole = { minX: -5, minY: -5, width: 45, height: 10 };
    expect(exchangeRun({ sheets: [whole] })).toEqual([]);
  });

  it("the exchange is a control for numbers and descriptions", () => {
    const noDesc = sites.map((s) => (s.id === "32" ? { ...s, description: null } : s));
    expect(exchangeRun({ sites: noDesc }).map((c) => [c.code, c.siteIds[0]])).toEqual([["DESCRIPTION_MISSING", "32"]]);
  });

  it("NUMBER_* read the derived part only", () => {
    const derivation: CourseDerivation = {
      sites: [{ id: "32", code: "32", role: "control", x: 1, y: 1, cuts: [], label: { text: "2", x: 2, y: 2 } }, { id: "33", code: "33", role: "control", x: 1, y: 1, cuts: [], label: { text: "3", x: 2, y: 2 } }],
      courses: [{ id: "c", orderMode: "ordered", sequence: [{ siteId: "32", role: "control" }, { siteId: "33", role: "control" }, { siteId: "F1", role: "finish" }], legs: [], section: { index: 1, count: 2 } }],
    };
    expect(exchangeRun({ derivation }).filter((c) => c.code.startsWith("NUMBER_"))).toEqual([]);
  });
});

describe("numbers", () => {
  const derivation = (labels: Record<string, { collides?: true } | null>): CourseDerivation => ({
    sites: Object.entries(labels).map(([id, l]) => ({ id, code: id, role: "control", x: 1, y: 1, cuts: [], ...(l ? { label: { text: id, x: 2, y: 2, ...l } } : {}) })),
    courses: [],
  });
  it("NUMBER_OVERLAPS from the placer's collides flag", () => {
    const found = run({ derivation: derivation({ "31": {}, "32": { collides: true }, "33": {} }) }).filter((c) => c.code.startsWith("NUMBER_"));
    expect(found.map((c) => [c.code, c.siteIds[0]])).toEqual([["NUMBER_OVERLAPS", "32"]]);
  });
  it("NUMBER_UNPLACED for a visible control visit without a label", () => {
    const found = run({ derivation: derivation({ "31": {}, "32": {} }) }).filter((c) => c.code.startsWith("NUMBER_"));
    expect(found.map((c) => [c.code, c.siteIds[0]])).toEqual([["NUMBER_UNPLACED", "33"]]);
    const hidden = course(undefined, { items: course().items.map((i) => (i.siteId === "33" ? { ...i, numberHidden: true } : i)) });
    expect(codes({ structure: hidden, derivation: derivation({ "31": {}, "32": {} }) })).not.toContain("NUMBER_UNPLACED");
  });
  it("are skipped without a derivation", () => {
    expect(codes({ derivation: null })).toEqual([]);
  });
});

describe("DESCRIPTION_MISSING", () => {
  it("flags a course control without a description or column D, not start / finish or other courses' sites", () => {
    const sites = [...SITES.map((s) => (s.id === "32" ? { ...s, description: null } : s.id === "33" ? { ...s, description: { d: "" } } : s)), S("50", 80, 80, { description: null })];
    const found = run({ sites }).filter((c) => c.code === "DESCRIPTION_MISSING");
    expect(found.map((c) => c.siteIds[0])).toEqual(["32", "33"]);
  });
});

describe("legs", () => {
  /** A 709 area over leg 32 → 33 and a 521 building across leg 31 → 32. */
  const oob: CheckObstacle = { kind: "oob", code: "709", closed: true, points: [{ x: 21, y: -2 }, { x: 24, y: -2 }, { x: 24, y: 2 }, { x: 21, y: 2 }] };
  const building: CheckObstacle = { kind: "uncrossable", code: "521.1", closed: true, points: [{ x: 14, y: -1 }, { x: 16, y: -1 }, { x: 16, y: 1 }, { x: 14, y: 1 }] };
  const document = { libraryId: "ISOM2017-2" as const, obstacles: [oob, building] };
  it("LEG_CROSSES_OOB and LEG_THROUGH_UNCROSSABLE at the first crossing, with the leg's index", () => {
    const found = run({ document }).filter((c) => c.code.startsWith("LEG_"));
    expect(found).toEqual([
      { code: "LEG_CROSSES_OOB", siteIds: ["32", "33"], leg: { from: "32", to: "33", index: 2 }, at: { x: 21, y: 0 }, params: { from: "32", to: "33", symbol: "709" } },
      { code: "LEG_THROUGH_UNCROSSABLE", siteIds: ["31", "32"], leg: { from: "31", to: "32", index: 1 }, at: { x: 14, y: 0 }, params: { from: "31", to: "32", symbol: "521.1" } },
    ]);
  });
  it("test the bent polyline (F1): a bend around the building clears it, the first hit along the bends is reported", () => {
    const items = (bends: Array<{ x: number; y: number }>) => course(undefined, { items: ["S1", "31", "32", "33", "F1"].map((siteId) => (siteId === "32" ? { siteId, leg: { bends } } : { siteId })) });
    const around = run({ document, structure: items([{ x: 15, y: 3 }]) }).filter((c) => c.code.startsWith("LEG_"));
    expect(around.map((c) => [c.code, c.leg?.index])).toEqual([["LEG_CROSSES_OOB", 2]]);
    const into = run({ document, structure: items([{ x: 15, y: 3 }, { x: 22.5, y: 3 }, { x: 22.5, y: 0 }]) }).filter((c) => c.code.startsWith("LEG_"));
    expect(into.map((c) => [c.code, c.leg?.index, c.at])).toEqual([["LEG_CROSSES_OOB", 1, { x: 22.5, y: 2 }], ["LEG_CROSSES_OOB", 2, { x: 21, y: 0 }]]);
    expect(into[0].leg).toEqual({ from: "31", to: "32", index: 1 });
  });
  it("test the flattened curve (F13): handles that pull the leg through the building report it, the corners alone do not", () => {
    const items = (bends: PathVertex[]) => course(undefined, { items: ["S1", "31", "32", "33", "F1"].map((siteId) => (siteId === "32" ? { siteId, leg: { bends } } : { siteId })) });
    const corners = [{ x: 12, y: 3 }, { x: 18, y: 3 }];
    expect(run({ document, structure: items(corners) }).filter((c) => c.code === "LEG_THROUGH_UNCROSSABLE")).toEqual([]);
    const curved = run({ document, structure: items([{ x: 12, y: 3, hOut: { x: 6, y: -6 } }, { x: 18, y: 3 }]) }).filter((c) => c.code === "LEG_THROUGH_UNCROSSABLE");
    expect(curved.map((c) => c.leg?.index)).toEqual([1]);
    // The hit lies on the curve, below the corners' line.
    expect(curved[0].at!.y).toBeLessThan(1 + 1e-9);
    expect(curved[0].at!.x).toBeGreaterThan(14 - 1e-9);
  });
  describe("a leg through a crossing point (§9.3, §10.3, F4)", () => {
    const through = (x: number, y: number, extra: CheckObstacle[] = []) => {
      const sites = [...SITES, S("P", x, y, { kind: "crossing_point", description: null })];
      const structure = course(undefined, { items: ["S1", "31", "32", "33", "F1"].map((siteId) => (siteId === "32" ? { siteId, leg: { crossing: { controlId: "P" } } } : { siteId })) });
      return run({ document: { ...document, obstacles: [...document.obstacles, ...extra] }, sites, structure }).filter((c) => c.code.startsWith("LEG_"));
    };
    it("is exempt at the obstacle the crossing sits on; the other legs still report", () => {
      expect(through(14, 0).map((c) => [c.code, c.leg?.index])).toEqual([["LEG_CROSSES_OOB", 2]]);
      // Within the reach of the wall from outside (1 mm east of it).
      expect(through(17, 0).map((c) => [c.code, c.leg?.index])).toEqual([["LEG_CROSSES_OOB", 2]]);
    });
    it("a second obstacle on the same leg still reports", () => {
      const wall: CheckObstacle = { kind: "uncrossable", code: "201", closed: false, points: [{ x: 18, y: -3 }, { x: 18, y: 3 }] };
      expect(through(14, 0, [wall]).map((c) => [c.code, c.leg?.index, c.params?.symbol])).toEqual([["LEG_CROSSES_OOB", 2, "709"], ["LEG_THROUGH_UNCROSSABLE", 1, "201"]]);
    });
    it("a crossing 2 mm off the obstacle exempts nothing", () => {
      expect(through(18, 0).map((c) => [c.code, c.leg?.index])).toEqual([["LEG_CROSSES_OOB", 2], ["LEG_THROUGH_UNCROSSABLE", 1]]);
    });
    it("the routed polyline is tested: a crossing beside the building takes the leg round it", () => {
      expect(through(15, 3).map((c) => [c.code, c.leg?.index])).toEqual([["LEG_CROSSES_OOB", 2]]);
    });
  });
  it("a leg running inside an area without crossing its edge", () => {
    const inside: CheckObstacle = { ...oob, points: [{ x: 15, y: -3 }, { x: 30, y: -3 }, { x: 30, y: 3 }, { x: 15, y: 3 }] };
    const found = run({ document: { libraryId: "ISOM2017-2", obstacles: [inside] } }).filter((c) => c.code === "LEG_CROSSES_OOB");
    expect(found.map((c) => c.leg?.index)).toEqual([1, 2, 3]);
    expect(found[1].at).toEqual({ x: 22.5, y: 0 });
  });
  it("an open line (708) is crossed, not entered", () => {
    const line: CheckObstacle = { kind: "oob", code: "708", closed: false, points: [{ x: 12, y: 5 }, { x: 12, y: -5 }] };
    expect(run({ document: { libraryId: "ISOM2017-2", obstacles: [line] } }).map((c) => c.leg?.index)).toEqual([1]);
  });
  it("course objects: oob_area and a 708 oob_line, not a 711 route", () => {
    const objects: CourseLayerObject[] = [
      { id: 1, kind: "oob_area", geometry: oob.points, props: {} },
      { id: 2, kind: "oob_line", geometry: [{ x: 12, y: 5 }, { x: 12, y: -5 }], props: { symbol: "711" } },
      { id: 3, kind: "oob_line", geometry: [{ x: 30, y: 5 }, { x: 30, y: -5 }], props: {} },
    ];
    expect(run({ objects }).map((c) => [c.code, c.leg?.index])).toEqual([["LEG_CROSSES_OOB", 2], ["LEG_CROSSES_OOB", 3]]);
  });
  it("free order has no legs; unpositioned items are skipped as the layer skips them", () => {
    expect(codes({ document, structure: course(undefined, { orderMode: "free_order" }) })).toEqual([]);
    const sites = [...SITES, S("40", 0, 0)];
    const found = run({ document, sites, structure: course(["S1", "31", "40", "32", "33", "F1"]) }).filter((c) => c.code.startsWith("LEG_"));
    expect(found.map((c) => c.leg)).toEqual([{ from: "32", to: "33", index: 2 }, { from: "31", to: "32", index: 1 }]);
  });
});

describe("variation groups (§9.2 VARIATION_*, F7)", () => {
  // Anchor 31 (10, 0), next 33 (25, 0): the straight leg is 150 m at 1:10 000.
  const sites = [...SITES, S("40", 17.5, 2), S("41", 17.5, 10), S("P", 17.5, -3, { kind: "crossing_point", description: null })];
  const group = (alts: string[][], over: Partial<CheckVariationGroup> = {}): CheckVariationGroup => ({
    id: "g", anchor: "31", next: "33", loop: false,
    alternatives: alts.map((ids, i) => ({ label: String.fromCharCode(65 + i), items: ids.map((siteId) => ({ siteId })) })),
    ...over,
  });
  const found = (g: CheckVariationGroup, mapScale: number | null = 10000) =>
    run({ sites, groups: [g], mapScale }).filter((c) => c.code.startsWith("VARIATION_"));

  it("flags alternatives more than 10 % apart, once per group, at the anchor, shortest and longest named", () => {
    const [c] = found(group([[], ["41"]]));
    expect(c.code).toBe("VARIATION_UNBALANCED");
    expect(c.siteIds).toEqual(["31"]);
    expect(c.at).toEqual({ x: 10, y: 0 });
    expect(c.params).toMatchObject({ a: "A", b: "B", lengthA: 150, unit: "m" });
    expect(Number(c.params!.lengthB)).toBeGreaterThan(150);
    expect(found(group([[], ["41"]]))).toHaveLength(1);
  });

  it("within 10 % is balanced; an empty plain alternative is the straight leg", () => {
    // 31 → 40 → 33: 2 × hypot(7.5, 2) mm ≈ 155 m against 150 m.
    expect(found(group([[], ["40"]]))).toEqual([]);
  });

  it("measures along the legs' bends and crossing points", () => {
    const bent = group([[], []]);
    bent.alternatives[1].items = [{ siteId: "40", leg: { bends: [{ x: 12, y: 12 }] } }];
    expect(found(bent).map((c) => c.code)).toEqual(["VARIATION_UNBALANCED"]);
    const crossed = group([[], []]);
    crossed.alternatives[1].items = [{ siteId: "40", leg: { crossing: { controlId: "P" } } }];
    expect(found(crossed).map((c) => c.code)).toEqual(["VARIATION_UNBALANCED"]);
    // Along a curve (F13): a handle that loops the leg makes it long; the same bend without one does not.
    const curved = (bend: PathVertex) => { const g = group([[], []]); g.alternatives[1].items = [{ siteId: "40", leg: { bends: [bend] } }]; return g; };
    expect(found(curved({ x: 14, y: 1 }))).toEqual([]);
    expect(found(curved({ x: 14, y: 1, hOut: { x: 0, y: 20 } })).map((c) => c.code)).toEqual(["VARIATION_UNBALANCED"]);
    // The exit leg is every alternative's: its bend lengthens both.
    expect(found(group([[], ["40"]], { exitLeg: { bends: [{ x: 22, y: 12 }] } }))).toEqual([]);
  });

  it("a loop compares its non-empty petals back to the anchor", () => {
    expect(found(group([["40"], ["41"]], { loop: true })).map((c) => c.code)).toEqual(["VARIATION_UNBALANCED"]);
    expect(found(group([["41"], []], { loop: true }))).toEqual([]);
  });

  it("an all-empty group is VARIATION_ALL_EMPTY (valid, a warning); unpositioned anchors are skipped", () => {
    expect(found(group([[], []])).map((c) => [c.code, c.siteIds])).toEqual([["VARIATION_ALL_EMPTY", ["31"]]]);
    expect(run({ sites: sites.map((s) => (s.id === "31" ? { ...s, x: 0, y: 0 } : s)), groups: [group([[], ["41"]])] }).filter((c) => c.code.startsWith("VARIATION_"))).toEqual([]);
  });

  it("without a scale the lengths are paper mm; the codes sort after the leg checks", () => {
    expect(found(group([[], ["41"]]), null)[0].params).toMatchObject({ lengthA: 15, unit: "mm" });
    expect(COURSE_CHECK_CODES.slice(-3)).toEqual(["LEG_THROUGH_UNCROSSABLE", "VARIATION_UNBALANCED", "VARIATION_ALL_EMPTY"]);
  });
});

describe("output", () => {
  it("is ordered by the code table, then input order, and deterministic", () => {
    const sites = [...SITES.map((s) => (s.id === "32" ? { ...s, description: null } : s)), S("x", 50, 50, { codes: [30] }), S("dup", 10.5, 0, { codes: [31] })];
    const a = run({ sites });
    expect(a.map((c) => c.code)).toEqual(["CONTROL_TOO_CLOSE", "CODE_BELOW_31", "CODE_DUPLICATE", "DESCRIPTION_MISSING"]);
    expect(run({ sites })).toEqual(a);
    expect(COURSE_CHECK_CODES).toHaveLength(15);
  });
});

describe("checkObstaclesOfDocument", () => {
  const sym = (code: string, kind: "line" | "area", over = {}) => ({ code, name: code, kind, render: null, ...over });
  const header: MapDocumentInput["header"] = {
    format: { version: 1, importer: "test-1" },
    source: { kind: "ocad", version: "2018", hash: "00".repeat(32), bytes: 1 },
    unitsPerMm: 100,
    mapScale: 4000,
    georeferencing: { crs: null, paperOrigin: { x: 0, y: 0 }, gridRotationDeg: 0 },
    colours: [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] }],
    symbols: [
      sym("521.0", "area"), // 0 building by source code
      sym("900.0", "line", { match: { canonicalId: "ISSprOM2019-2:515", method: "geometry", state: "auto", confidence: 0.9, libraryVersion: SYMBOL_LIBRARY_VERSION } }), // 1 wall by applied match
      sym("709.0", "area"), // 2 oob
      sym("201.0", "line", { hidden: true }), // 3 hidden cliff
      sym("521.0", "area", { match: { canonicalId: "ISSprOM2019-2:401", method: "geometry", state: "auto", confidence: 0.9, libraryVersion: SYMBOL_LIBRARY_VERSION } }), // 4 matched away
      sym("515.0", "line", { match: { canonicalId: "ISSprOM2019-2:401", method: "geometry", state: "suggested", confidence: 0.5, libraryVersion: SYMBOL_LIBRARY_VERSION } }), // 5 suggested: source code decides
    ],
  };
  const obj = (symbolIdx: number, type: number, coords: number[], flags?: number[]) => ({ symbolIdx, type, sourceIndex: 0, coords, flags: flags ?? new Array(coords.length / 2).fill(0) });

  it("keeps uncrossable and out-of-bounds lines and areas by applied match, else source code; on-curve vertices, outer ring", () => {
    const doc = decodeMapDocument(encodeMapDocument({
      header,
      objects: [
        obj(0, OBJECT_TYPE.area, [0, 0, 1000, 0, 1000, 1000, 200, 200, 300, 200, 300, 300], [0, 0, 0, COORD_FLAG.hole, 0, 0]),
        obj(1, OBJECT_TYPE.line, [0, 0, 500, 500, 600, 500, 1000, 0], [0, COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, 0]),
        obj(2, OBJECT_TYPE.area, [0, 0, 100, 0, 100, 100]),
        obj(3, OBJECT_TYPE.line, [0, 0, 100, 0]),
        obj(4, OBJECT_TYPE.area, [0, 0, 100, 0, 100, 100]),
        obj(5, OBJECT_TYPE.line, [0, 0, 200, 0]),
        obj(0, OBJECT_TYPE.point, [0, 0]),
      ],
    }));
    const got = checkObstaclesOfDocument(doc);
    expect(got.libraryId).toBe("ISSprOM2019-2");
    const byCode = (a: CheckObstacle, b: CheckObstacle) => a.code.localeCompare(b.code) || a.points.length - b.points.length;
    expect([...got.obstacles].sort(byCode)).toEqual([
      { kind: "uncrossable", code: "515", closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { kind: "uncrossable", code: "515.0", closed: false, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] },
      { kind: "uncrossable", code: "521.0", closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
      { kind: "oob", code: "709.0", closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
    ]);
  });

  it("reads the effective document: a hidden obstacle is gone, an added one counts (docs/map-patches.md §2.4)", () => {
    const doc = decodeMapDocument(encodeMapDocument({
      header,
      objects: [
        { ...obj(2, OBJECT_TYPE.area, [0, 0, 100, 0, 100, 100]), sourceIndex: 3 },
        { ...obj(0, OBJECT_TYPE.area, [0, 0, 1000, 0, 1000, 1000]), sourceIndex: 4 },
      ],
    }));
    const patch = mapPatchSchema.parse({
      documentHash: "ab".repeat(32),
      ops: {
        "hide:4": { op: "hide", sourceIndex: 4 },
        "add:00000000-0000-4000-8000-000000000001": { op: "add", id: "00000000-0000-4000-8000-000000000001", type: OBJECT_TYPE.line, symbol: { doc: 1 }, coords: [[0, 500], [800, 500]] },
      },
    });
    const { document, issues } = applyPatch(doc, patch);
    expect(issues).toEqual([]);
    expect(checkObstaclesOfDocument(document).obstacles).toEqual([
      { kind: "oob", code: "709.0", closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
      { kind: "uncrossable", code: "515", closed: false, points: [{ x: 0, y: 5 }, { x: 8, y: 5 }] },
    ]);
  });

  it("names uncrossable or forbidden features in both libraries, and 708 / 709 out of bounds", () => {
    for (const id of ["ISOM2017-2", "ISSprOM2019-2"] as const) {
      const lib = getSymbolLibrary(id);
      const nameOf = (code: number) => lib.entries.filter((e) => parseInt(e.code, 10) === code).map((e) => e.name.en).join(" | ");
      for (const code of UNCROSSABLE_CODES) {
        const name = nameOf(code);
        if (!name) continue; // ISOM 2017-2's library has no 411 entry; the code is the standard's
        expect(name, `${id} ${code}`).toMatch(/uncrossable|impassable|not be entered|building/i);
      }
      for (const code of OOB_CODES) expect(nameOf(code), `${id} ${code}`).toMatch(/out-of-bounds/i);
    }
  });
});
