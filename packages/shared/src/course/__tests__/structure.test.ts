/** The stored course structure (course-layer.md §6; 08 §4.3). */

import { describe, expect, it } from "vitest";
import {
  courseStructureSchema,
  courseStructureWireSchema,
  hasVariations,
  linearStructure,
  structureControlIds,
  structureDiff,
  structureSiteIssues,
  type StoredCourseStructure,
} from "../structure.js";

const linear = (ids: string[]) => linearStructure("c1", ids.map((siteId) => ({ siteId })));
const parse = (value: unknown) => courseStructureSchema.safeParse(value);
const issueCodes = (value: unknown) => {
  const r = parse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
const variation = (id: string, alts: string[][], extra: Record<string, unknown> = {}) => ({
  kind: "variation" as const,
  id,
  alternatives: alts.map((ids, i) => ({ label: String.fromCharCode(65 + i), items: ids.map((siteId) => ({ siteId })) })),
  ...extra,
});

describe("courseStructureSchema", () => {
  it("accepts C0's v1 shape (a linear structure with leg gaps, label offsets, a hidden number)", () => {
    const s = {
      version: 1,
      id: "c1",
      orderMode: "ordered",
      items: [{ siteId: "S", role: "start" }, { siteId: "31", leg: { gaps: [{ from: 0.2, to: 0.3 }] }, numberHidden: true }, { siteId: "F" }],
      labelOffsets: { "31": { dx: 1, dy: -2 } },
    };
    expect(parse(s).success).toBe(true);
  });

  it("refuses C0's interim file-authored input (no LegProps.path; authored cuts live on the site) and extras", () => {
    const base = linear(["S", "31"]);
    expect(parse({ ...base, items: [{ siteId: "S" }, { siteId: "31", leg: { path: [{ x: 0, y: 0 }] } }] }).success).toBe(false);
    expect(parse({ ...base, items: [{ siteId: "S" }, { siteId: "31", leg: { pieces: [] } }] }).success).toBe(false);
    expect(parse({ ...base, items: [{ siteId: "S" }, { siteId: "31", circleGaps: [{ start: 1, end: 2 }] }] }).success).toBe(false);
    expect(parse({ ...base, extras: [] }).success).toBe(false);
  });

  it("has a wire form over public control ids", () => {
    expect(courseStructureWireSchema.safeParse({ version: 1, id: "7", orderMode: "ordered", items: [{ siteId: 31 }, { siteId: 32 }] }).success).toBe(true);
    expect(courseStructureWireSchema.safeParse({ version: 1, id: "7", orderMode: "ordered", items: [{ siteId: "31" }] }).success).toBe(false);
  });

  it("accepts the 08 §4.3 leg props and an explicit control kind", () => {
    const s = {
      ...linear(["S", "31", "F"]),
      items: [
        { kind: "control", siteId: "S" },
        { kind: "control", siteId: "31", leg: { style: "marked_route", bends: [{ x: 1, y: 2 }], corridor: { widthM: 20, edge: true, whiteMm: 0.5, whiteOpacity: 0.5 }, crossing: { controlId: "X" } } },
        { kind: "control", siteId: "F", leg: { style: "none" } },
      ],
    };
    expect(parse(s).success).toBe(true);
  });

  it("accepts a variation group between two anchors, and a butterfly loop", () => {
    const s = { ...linear([]), items: [{ siteId: "S" }, { siteId: "31" }, variation("v1", [["32"], ["33"]]), { siteId: "34" }, variation("v2", [["35"], ["36"]], { loop: true }), { siteId: "34" }, { siteId: "F" }] };
    expect(parse(s).success).toBe(true);
    expect(hasVariations(parse(s).data as StoredCourseStructure)).toBe(true);
  });

  it("rejects nesting: an alternative holds controls only", () => {
    const nested = { ...linear([]), items: [{ siteId: "S" }, { kind: "variation", id: "v1", alternatives: [{ label: "A", items: [variation("v2", [["32"], ["33"]])] }, { label: "B", items: [{ siteId: "34" }] }] }, { siteId: "F" }] };
    expect(parse(nested).success).toBe(false);
  });

  it("rejects overlap: adjacent groups, or a group without an anchor on either side", () => {
    expect(issueCodes({ ...linear([]), items: [{ siteId: "S" }, variation("v1", [["32"], ["33"]]), variation("v2", [["34"], ["35"]]), { siteId: "F" }] })).toContain("VARIATION_OVERLAP");
    expect(issueCodes({ ...linear([]), items: [variation("v1", [["32"], ["33"]]), { siteId: "F" }] })).toContain("VARIATION_UNANCHORED");
    expect(issueCodes({ ...linear([]), items: [{ siteId: "S" }, variation("v1", [["32"], ["33"]])] })).toContain("VARIATION_UNANCHORED");
  });

  it("rejects duplicate group ids, duplicate labels, fewer than two alternatives and empty alternatives", () => {
    const dupId = { ...linear([]), items: [{ siteId: "S" }, variation("v", [["32"], ["33"]]), { siteId: "34" }, variation("v", [["35"], ["36"]]), { siteId: "F" }] };
    expect(issueCodes(dupId)).toContain("VARIATION_ID_DUPLICATE");
    const dupLabel = { ...linear([]), items: [{ siteId: "S" }, { kind: "variation", id: "v", alternatives: [{ label: "A", items: [{ siteId: "1" }] }, { label: "A", items: [{ siteId: "2" }] }] }, { siteId: "F" }] };
    expect(issueCodes(dupLabel)).toContain("VARIATION_LABEL_DUPLICATE");
    expect(parse({ ...linear([]), items: [{ siteId: "S" }, variation("v", [["32"]]), { siteId: "F" }] }).success).toBe(false);
    expect(parse({ ...linear([]), items: [{ siteId: "S" }, variation("v", [["32"], []]), { siteId: "F" }] }).success).toBe(false);
  });

  it("rejects out-of-range leg gaps and unknown fields' wrong types", () => {
    expect(parse({ ...linear([]), items: [{ siteId: "S" }, { siteId: "31", leg: { gaps: [{ from: 0.5, to: 1.5 }] } }] }).success).toBe(false);
    expect(parse({ ...linear(["S"]), version: 2 }).success).toBe(false);
    expect(parse({ ...linear(["S"]), orderMode: "score" }).success).toBe(false);
  });
});

describe("structureSiteIssues (rules that need the sites)", () => {
  const kinds = new Map<string, string>([["S", "start"], ["31", "control"], ["32", "control"], ["33", "control"], ["X", "map_exchange"], ["F", "finish"]]);

  it("flags unknown sites", () => {
    expect(structureSiteIssues(linear(["S", "31", "nope", "F"]), kinds)).toEqual([{ code: "SITE_UNKNOWN", siteId: "nope" }]);
  });

  it("rejects a group spanning a map exchange", () => {
    const s = courseStructureSchema.parse({ ...linear([]), items: [{ siteId: "S" }, { siteId: "31" }, variation("v1", [["X"], ["33"]]), { siteId: "32" }, { siteId: "F" }] });
    expect(structureSiteIssues(s, kinds)).toEqual([{ code: "VARIATION_CROSSES_EXCHANGE", siteId: "X" }]);
  });

  it("is empty for a valid linear course", () => {
    expect(structureSiteIssues(linear(["S", "31", "32", "F"]), kinds)).toEqual([]);
  });
});

describe("linearStructure / structureControlIds", () => {
  it("builds the v1 linear shape from a sequence", () => {
    const s = linearStructure("c9", [{ siteId: "S", role: "start" }, { siteId: "31" }, { siteId: "F" }], { orderMode: "free_order", labelOffsets: { "31": { dx: 1, dy: 1 } } });
    expect(s).toEqual({ version: 1, id: "c9", orderMode: "free_order", items: [{ siteId: "S", role: "start" }, { siteId: "31" }, { siteId: "F" }], labelOffsets: { "31": { dx: 1, dy: 1 } } });
    expect(courseStructureSchema.parse(s)).toEqual(s);
  });

  it("omits empty label offsets", () => {
    expect(linearStructure("c", [{ siteId: "S" }], { labelOffsets: {} })).not.toHaveProperty("labelOffsets");
  });

  it("lists the flat site sequence, a group by its first alternative (08 §4.3 root path)", () => {
    expect(structureControlIds(linear(["S", "31", "31", "F"]))).toEqual(["S", "31", "31", "F"]);
    const s = courseStructureSchema.parse({ ...linear([]), items: [{ siteId: "S" }, variation("v1", [["32", "33"], ["34"]]), { siteId: "F" }] });
    expect(structureControlIds(s)).toEqual(["S", "32", "33", "F"]);
  });
});

describe("structureDiff (the CONFLICT payload's `differing`, course-layer.md §7)", () => {
  it("is empty for equal structures", () => {
    expect(structureDiff(linear(["S", "31", "F"]), linear(["S", "31", "F"]))).toEqual([]);
  });

  it("names the items added, removed or moved (outside the longest common subsequence)", () => {
    const swapped = structureDiff(linear(["S", "31", "32", "F"]), linear(["S", "32", "31", "F"]));
    expect(swapped).toHaveLength(1);
    expect(["31", "32"]).toContain(swapped[0]);
    expect(structureDiff(linear(["S", "31", "F"]), linear(["S", "31", "33", "F"]))).toEqual(["33"]);
    expect(structureDiff(linear(["S", "31", "F"]), linear(["S", "F"]))).toEqual(["31"]);
  });

  it("names an item whose leg or gaps changed, and a changed label offset", () => {
    const a = linear(["S", "31", "F"]);
    const b: StoredCourseStructure = { ...a, items: a.items.map((it) => ("siteId" in it && it.siteId === "31" ? { ...it, leg: { gaps: [{ from: 0.1, to: 0.2 }] } } : it)) };
    expect(structureDiff(a, b)).toEqual(["31"]);
    expect(structureDiff(a, { ...a, labelOffsets: { F: { dx: 1, dy: 0 } } })).toEqual(["F"]);
  });

  it("treats a null side as empty", () => {
    expect(structureDiff(null, linear(["S", "F"]))).toEqual(["F", "S"]);
  });
});
