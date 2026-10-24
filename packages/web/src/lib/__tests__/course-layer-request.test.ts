import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { courseLayerRequest, type CourseRequestInput, type RequestControl } from "../course-layer-request";

const ctl = (id: string, type: RequestControl["type"] = "Control", visible?: boolean): RequestControl => ({ id, code: `c${id}`, type, ...(visible === undefined ? {} : { visible }) });
const CONTROLS = [ctl("S", "Start"), ctl("1"), ctl("2"), ctl("3"), ctl("F", "Finish")];
const POS = new Map(Object.entries({ S: { x: 10, y: 10 }, 1: { x: 40, y: 10 }, 2: { x: 60, y: 40 }, 3: { x: 30, y: 50 }, F: { x: 10, y: 40 } }));

const base = (over: Partial<CourseRequestInput> = {}): CourseRequestInput => ({
  controls: CONTROLS,
  positions: POS,
  courses: [{ name: "A", controls: ["S", "1", "2", "F"], highlight: true }, { name: "B", controls: ["S", "3", "F"] }],
  sequenceLabels: true,
  ...over,
});
const structures = (r: ReturnType<typeof courseLayerRequest>) => (r.structure ?? []) as course.CourseStructure[];

describe("courseLayerRequest (docs/course-layer.md §5)", () => {
  it("sites from positioned, visible controls with their kinds; the highlighted course as items", () => {
    const r = courseLayerRequest(base({
      controls: [...CONTROLS, ctl("9", "Control", false), ctl("8")],
      positions: new Map([...POS, ["9", { x: 1, y: 1 }], ["8", { x: 0, y: 0 }]]),
    }));
    expect(r.sites.map((s) => [s.id, s.kind])).toEqual([["S", "start"], ["1", "control"], ["2", "control"], ["3", "control"], ["F", "finish"]]);
    expect(structures(r).map((s) => s.id)).toEqual(["A"]);
    expect(structures(r)[0].items.map((i) => i.siteId)).toEqual(["S", "1", "2", "F"]);
    expect(r.objects).toEqual([]);
    expect(r.appearance).toEqual({});
  });

  it("a visible control on no highlighted course turns on all-controls; hidden ones do not", () => {
    expect(courseLayerRequest(base()).viewOptions.allControls).toBe(true);
    const onlyRelevant = courseLayerRequest(base({ controls: CONTROLS.map((c) => (c.id === "3" ? { ...c, visible: false } : c)) }));
    expect(onlyRelevant.viewOptions.allControls).toBeUndefined();
  });

  it("no highlighted course: no structure, every site with code labels", () => {
    const r = courseLayerRequest(base({ courses: [{ name: "A", controls: ["S", "1", "F"] }] }));
    expect(r.structure).toBeNull();
    expect(r.viewOptions).toEqual({ labelMode: "code", allControls: true });
  });

  it("sequence numbers only for one ordered course with descriptions or the editor", () => {
    expect(courseLayerRequest(base()).viewOptions.labelMode).toBe("sequence");
    expect(courseLayerRequest(base({ sequenceLabels: false })).viewOptions.labelMode).toBe("code");
    expect(courseLayerRequest(base({ courses: [{ name: "A", controls: ["S", "1", "F"], highlight: true, orderMode: "free_order" }] })).viewOptions.labelMode).toBe("code");
    const two = courseLayerRequest(base({ courses: [{ name: "A", controls: ["S", "1", "F"], highlight: true }, { name: "B", controls: ["S", "3", "F"], highlight: true }] }));
    expect(two.viewOptions.labelMode).toBe("code");
    expect(structures(two).map((s) => s.id)).toEqual(["A", "B"]);
  });

  it("highlight by name; the single course's label offsets, pending ones winning", () => {
    const r = courseLayerRequest(base({
      courses: [{ name: "A", controls: ["S", "1", "2", "F"], labelOffsets: { 1: { dx: 1, dy: 2 } } }],
      highlightCourseName: "A",
    }));
    expect(structures(r)[0].labelOffsets).toEqual({ 1: { dx: 1, dy: 2 } });
    const pending = courseLayerRequest(base({
      courses: [{ name: "A", controls: ["S", "1", "2", "F"], highlight: true, labelOffsets: { 1: { dx: 1, dy: 2 } } }],
      labelOffset: (id) => (id === "2" ? { dx: -3, dy: 0 } : undefined),
    }));
    expect(structures(pending)[0].labelOffsets).toEqual({ 2: { dx: -3, dy: 0 } });
  });

  it("positions are taken as given (the viewer applies drags and pending moves)", () => {
    const r = courseLayerRequest(base({ positions: new Map([...POS, ["1", { x: 45, y: 12 }]]) }));
    expect(r.sites.find((s) => s.id === "1")).toMatchObject({ x: 45, y: 12 });
  });

  it("excluded (faded) controls are left to the UI layer", () => {
    const r = courseLayerRequest(base({ exclude: new Set(["3"]) }));
    expect(r.sites.map((s) => s.id)).not.toContain("3");
    expect(r.viewOptions.allControls).toBeUndefined();
  });

  it("an imported course: preclipped legs → pieces, its cuts → circle gaps, extras; legacy automatic gaps ignored", () => {
    const leg = (pts: number[][], props: Record<string, unknown> = {}) => ({ geometry: { type: "LineString", coordinates: pts }, properties: { symbolType: "leg", courseName: "A", ...props } });
    const features = [
      leg([[12, 10], [37, 10]], { preclipped: true }),
      leg([[42, 12], [58, 38]], { preclipped: true }),
      leg([[58, 40], [30, 45], [12, 40]], { preclipped: true }),
      { geometry: { type: "Point", coordinates: [40, 10] }, properties: { symbolType: "control", code: "c1", courseName: "A", cuts: [{ start: 10, end: 40 }] } },
      { geometry: { type: "LineString", coordinates: [[0, 0], [5, 5]] }, properties: { symbolType: "marked_route", courseName: "A" } },
      { geometry: { type: "Polygon", coordinates: [[[1, 1], [3, 1], [3, 3], [1, 1]]] }, properties: { symbolType: "restricted_area", courseName: "A" } },
      // Course B is not highlighted; an automatic-gap leg of a generated course is not read.
      leg([[10, 10], [30, 50]], { courseName: "B", gaps: [{ from: 0.4, to: 0.5 }] }),
    ];
    const r = courseLayerRequest(base({ courseGeometry: { features } }));
    const a = structures(r)[0];
    expect(a.items[1].leg).toEqual({ pieces: [[{ x: 12, y: 10 }, { x: 37, y: 10 }]] });
    expect(a.items[3].leg?.pieces?.[0]).toHaveLength(3);
    expect(a.items[1].circleGaps).toEqual([{ start: 10, end: 40 }]);
    expect(a.extras).toEqual([
      { kind: "marked_route", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
      { kind: "oob_area", points: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 1 }] },
    ]);
  });

  it("generated legs: a bent leg keeps its path, gaps and cuts are not taken; a count mismatch is ignored", () => {
    const leg = (pts: number[][], props: Record<string, unknown> = {}) => ({ geometry: { type: "LineString", coordinates: pts }, properties: { symbolType: "leg", courseName: "A", gaps: [{ from: 0.2, to: 0.3 }], ...props } });
    const cut = { geometry: { type: "Point", coordinates: [40, 10] }, properties: { symbolType: "control", code: "c1", courseName: "A", cuts: [{ start: 10, end: 40 }] } };
    const r = courseLayerRequest(base({ courseGeometry: { features: [leg([[10, 10], [40, 10]]), leg([[40, 10], [50, 30], [60, 40]]), leg([[60, 40], [10, 40]]), cut] } }));
    const a = structures(r)[0];
    expect(a.items[1].leg).toBeUndefined();
    expect(a.items[2].leg).toEqual({ path: [{ x: 40, y: 10 }, { x: 50, y: 30 }, { x: 60, y: 40 }] });
    expect(a.items[1].circleGaps).toBeUndefined();
    const short = courseLayerRequest(base({ courseGeometry: { features: [leg([[10, 10], [25, 30], [40, 10]], { preclipped: true })] } }));
    expect(structures(short)[0].items.every((i) => !i.leg)).toBe(true);
  });
});
