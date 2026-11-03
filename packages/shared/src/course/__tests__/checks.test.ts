/** Advisory course checks (course-layer.md §9): one fixture per code. */

import { describe, expect, it } from "vitest";
import { COURSE_CHECK_CODES, OOB_CODES, UNCROSSABLE_CODES, checkObstaclesOfDocument, courseChecks, invertedCode, type CheckObstacle, type CheckSite, type CourseChecksInput } from "../checks.js";
import { COORD_FLAG } from "../../render/pass-stream.js";
import { OBJECT_TYPE, decodeMapDocument, encodeMapDocument, type MapDocumentInput } from "../../map-document/index.js";
import { getSymbolLibrary, SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";
import type { CourseDerivation, CourseStructure } from "../types.js";
import type { CourseLayerObject } from "../objects.js";

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

describe("output", () => {
  it("is ordered by the code table, then input order, and deterministic", () => {
    const sites = [...SITES.map((s) => (s.id === "32" ? { ...s, description: null } : s)), S("x", 50, 50, { codes: [30] }), S("dup", 10.5, 0, { codes: [31] })];
    const a = run({ sites });
    expect(a.map((c) => c.code)).toEqual(["CONTROL_TOO_CLOSE", "CODE_BELOW_31", "CODE_DUPLICATE", "DESCRIPTION_MISSING"]);
    expect(run({ sites })).toEqual(a);
    expect(COURSE_CHECK_CODES).toHaveLength(12);
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
