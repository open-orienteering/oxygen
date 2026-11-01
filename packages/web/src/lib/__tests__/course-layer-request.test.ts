import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { courseLayerRequest, courseObjectsForView, type CourseRequestInput, type RequestControl } from "../course-layer-request";

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
    // Without the sheet or the editor, no manual offsets (the placer decides).
    const plain = courseLayerRequest(base({ sequenceLabels: false, courses: [{ name: "A", controls: ["S", "1", "2", "F"], highlight: true, labelOffsets: { 1: { dx: 1, dy: 2 } } }] }));
    expect(structures(plain)[0].labelOffsets).toBeUndefined();
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

  it("the structure's authored leg gaps and hidden numbers, the controls' circle cuts; nothing else is read", () => {
    const cuts = [{ start: 10, end: 40 }];
    const gaps = [{ from: 0.4, to: 0.6 }];
    const r = courseLayerRequest(base({
      controls: CONTROLS.map((c) => (c.id === "1" ? { ...c, circleGaps: cuts } : c)),
      courses: [{ name: "A", controls: ["S", "1", "2", "F"], highlight: true, legGaps: { "1>2": gaps, "9>2": [{ from: 0.1, to: 0.2 }] }, hiddenNumbers: [2] }],
    }));
    expect(r.sites.find((s) => s.id === "1")!.circleGaps).toEqual(cuts);
    expect(r.sites.find((s) => s.id === "2")!.circleGaps).toBeUndefined();
    const a = structures(r)[0];
    expect(a.items.map((i) => i.leg)).toEqual([undefined, undefined, { gaps }, undefined]);
    expect(a.items.map((i) => i.numberHidden)).toEqual([undefined, undefined, true, undefined]);
  });

  it("an empty gap list stays out of the request (the layer cuts automatically)", () => {
    const r = courseLayerRequest(base({
      controls: CONTROLS.map((c) => (c.id === "1" ? { ...c, circleGaps: [] } : c)),
      courses: [{ name: "A", controls: ["S", "1", "2", "F"], highlight: true, legGaps: { "1>2": [] } }],
    }));
    expect(r.sites.find((s) => s.id === "1")!.circleGaps).toBeUndefined();
    expect(structures(r)[0].items.every((i) => i.leg === undefined)).toBe(true);
  });
});

describe("course objects (docs/course-layer.md §8.2, §8.3)", () => {
  const SQUARE = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }];
  const obj = (id: number, inCourses: number[] | null): course.CourseObject =>
    ({ id, kind: "oob_area", geometry: SQUARE, props: {}, scope: inCourses === null ? { all: true } : { courses: inCourses, classes: [] }, z: 0, version: "1", inCourses }) as course.CourseObject;
  // 3: scoped to a class running A and B through its pool (resolved by the server).
  const OBJECTS = [obj(1, null), obj(2, [10]), obj(3, [10, 11]), obj(4, [11]), obj(6, [])];
  const COURSES = [{ id: 10, name: "A" }, { id: 11, name: "B" }];
  const ids = (list: course.CourseObject[]) => list.map((o) => o.id);

  it("drawn with a highlighted course among the resolved ones; nothing highlighted = all only; parked = nowhere", () => {
    expect(ids(courseObjectsForView(OBJECTS, new Set(["A"]), COURSES))).toEqual([1, 2, 3]);
    expect(ids(courseObjectsForView(OBJECTS, new Set(["B"]), COURSES))).toEqual([1, 3, 4]);
    expect(ids(courseObjectsForView(OBJECTS, new Set(), COURSES))).toEqual([1]);
    expect(ids(courseObjectsForView(OBJECTS, new Set(["A", "B"]), COURSES))).toEqual([1, 2, 3, 4]);
  });

  it("the request carries the objects' bodies and ids, without scope, z, token or resolved courses", () => {
    expect(courseLayerRequest(base()).objects).toEqual([]);
    const r = courseLayerRequest(base({ courseObjects: [OBJECTS[0], { ...obj(5, null), kind: "filter_region", props: { mode: "hide", symbols: "all" } } as course.CourseObject] }));
    expect(r.objects).toEqual([
      { id: 1, kind: "oob_area", geometry: SQUARE, props: {} },
      { id: 5, kind: "filter_region", geometry: SQUARE, props: { mode: "hide", symbols: "all" } },
    ]);
  });
});
