import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { courseLayerRequest, courseObjectsForView, provisionalDrawn, PROVISIONAL_SITE_ID, type CourseRequestInput, type ProvisionalVisit, type RequestControl } from "../course-layer-request";

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

  it("the event's auto cuts off go on the view options; on or absent adds no key (course-layer.md §3.4)", () => {
    expect(courseLayerRequest(base({ autoCuts: false })).viewOptions.autoCuts).toBe(false);
    expect("autoCuts" in courseLayerRequest(base({ autoCuts: true })).viewOptions).toBe(false);
    expect("autoCuts" in courseLayerRequest(base()).viewOptions).toBe(false);
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

  it("the structure's stored legs whole and hidden numbers, the controls' circle cuts; nothing else is read", () => {
    const cuts = [{ start: 10, end: 40 }];
    const leg = {
      style: "marked_route" as const,
      gaps: [{ from: 0.4, to: 0.6 }],
      bends: [{ x: 15, y: 25 }],
      corridor: { widthM: 60, edge: true, whiteMm: 3, whiteOpacity: 1 },
    };
    const r = courseLayerRequest(base({
      controls: CONTROLS.map((c) => (c.id === "1" ? { ...c, circleGaps: cuts } : c)),
      courses: [{ name: "A", controls: ["S", "1", "2", "F"], highlight: true, legs: { "1>2": leg, "9>2": { gaps: [{ from: 0.1, to: 0.2 }] }, "2>F": { style: "none" } }, hiddenNumbers: [2] }],
    }));
    expect(r.sites.find((s) => s.id === "1")!.circleGaps).toEqual(cuts);
    expect(r.sites.find((s) => s.id === "2")!.circleGaps).toBeUndefined();
    const a = structures(r)[0];
    expect(a.items.map((i) => i.leg)).toEqual([undefined, undefined, leg, { style: "none" }]);
    expect(a.items.map((i) => i.numberHidden)).toEqual([undefined, undefined, true, undefined]);
  });

  it("an empty leg stays out of the request (a plain 705 leg, cut automatically)", () => {
    const r = courseLayerRequest(base({
      controls: CONTROLS.map((c) => (c.id === "1" ? { ...c, circleGaps: [] } : c)),
      courses: [{ name: "A", controls: ["S", "1", "2", "F"], highlight: true, legs: { "1>2": {} } }],
    }));
    expect(r.sites.find((s) => s.id === "1")!.circleGaps).toBeUndefined();
    expect(structures(r)[0].items.every((i) => i.leg === undefined)).toBe(true);
  });
});

describe("the editor's provisional visit (docs/course-editor.md §6.1)", () => {
  const P = PROVISIONAL_SITE_ID;
  const at = { x: 70, y: 20 };
  const visit = (over: Partial<ProvisionalVisit>): ProvisionalVisit => ({ role: "control", insertAt: 0, pt: at, code: "47", ...over });
  const items = (r: ReturnType<typeof courseLayerRequest>) => structures(r)[0].items.map((i) => i.siteId);

  it("a control at the insertion point: a site at the cursor and an item before the control-sequence position", () => {
    const r = courseLayerRequest(base({ provisional: visit({ insertAt: 1 }) }));
    expect(items(r)).toEqual(["S", "1", P, "2", "F"]);
    expect(r.sites.find((s) => s.id === P)).toEqual({ id: P, code: "47", kind: "control", x: 70, y: 20 });
    expect(r.viewOptions.labelMode).toBe("sequence");
    expect(items(courseLayerRequest(base({ provisional: visit({ insertAt: 0 }) })))).toEqual(["S", P, "1", "2", "F"]);
  });

  it("past the last control: before the finish, else at the end", () => {
    expect(items(courseLayerRequest(base({ provisional: visit({ insertAt: 2 }) })))).toEqual(["S", "1", "2", P, "F"]);
    expect(items(courseLayerRequest(base({ provisional: visit({ insertAt: 9 }) })))).toEqual(["S", "1", "2", P, "F"]);
    const open = courseLayerRequest(base({ courses: [{ name: "A", controls: ["S", "1"], highlight: true }], provisional: visit({ insertAt: 1 }) }));
    expect(items(open)).toEqual(["S", "1", P]);
  });

  it("counts repeated visits of a control as positions", () => {
    const r = courseLayerRequest(base({ courses: [{ name: "A", controls: ["S", "1", "2", "1", "F"], highlight: true }], provisional: visit({ insertAt: 2 }) }));
    expect(items(r)).toEqual(["S", "1", "2", P, "1", "F"]);
  });

  it("a start replaces the course's start (else leads); a finish replaces its finish (else ends)", () => {
    expect(items(courseLayerRequest(base({ provisional: visit({ role: "start" }) })))).toEqual([P, "1", "2", "F"]);
    expect(items(courseLayerRequest(base({ provisional: visit({ role: "finish" }) })))).toEqual(["S", "1", "2", P]);
    const bare = base({ courses: [{ name: "A", controls: ["1", "2"], highlight: true }] });
    expect(items(courseLayerRequest({ ...bare, provisional: visit({ role: "start" }) }))).toEqual([P, "1", "2"]);
    expect(items(courseLayerRequest({ ...bare, provisional: visit({ role: "finish" }) }))).toEqual(["1", "2", P]);
    expect(courseLayerRequest(base({ provisional: visit({ role: "finish" }) })).sites.find((s) => s.id === P)?.kind).toBe("finish");
  });

  it("a reused site is spliced by its id and adds no site", () => {
    const r = courseLayerRequest(base({ provisional: visit({ insertAt: 1, reuseId: "3" }) }));
    expect(items(r)).toEqual(["S", "1", "3", "2", "F"]);
    expect(r.sites.map((s) => s.id)).toEqual(["S", "1", "2", "3", "F"]);
  });

  it("provisionalDrawn: the layer adds a site for a visit, none for a reuse or without one (the UI-layer ghost circle is its negation, P4)", () => {
    expect(provisionalDrawn(null)).toBe(false);
    expect(provisionalDrawn(undefined)).toBe(false);
    expect(provisionalDrawn(visit({ insertAt: 1 }))).toBe(true);
    expect(provisionalDrawn(visit({ insertAt: 1, reuseId: "3" }))).toBe(false);
    for (const v of [visit({ insertAt: 1 }), visit({ insertAt: 1, reuseId: "3" })]) {
      expect(courseLayerRequest(base({ provisional: v })).sites.some((s) => s.id === P)).toBe(provisionalDrawn(v));
    }
  });

  it("the leg the visit splits loses its stored leg (style, bends, corridor too); the others keep theirs", () => {
    const leg = { gaps: [{ from: 0.4, to: 0.6 }], style: "marked_route" as const, bends: [{ x: 15, y: 25 }] };
    const r = courseLayerRequest(base({
      courses: [{ name: "A", controls: ["S", "1", "2", "F"], highlight: true, legs: { "1>2": leg, "2>F": leg } }],
      provisional: visit({ insertAt: 1 }),
    }));
    expect(structures(r)[0].items.map((i) => i.leg)).toEqual([undefined, undefined, undefined, undefined, leg]);
  });

  it("ignored without exactly one highlighted course", () => {
    const none = courseLayerRequest(base({ courses: [{ name: "A", controls: ["S", "1", "F"] }], provisional: visit({}) }));
    expect(none.sites.map((s) => s.id)).not.toContain(P);
    const two = courseLayerRequest(base({
      courses: [{ name: "A", controls: ["S", "1", "F"], highlight: true }, { name: "B", controls: ["S", "3", "F"], highlight: true }],
      provisional: visit({}),
    }));
    expect(two.sites.map((s) => s.id)).not.toContain(P);
    expect(structures(two).map((s) => s.items.map((i) => i.siteId))).toEqual([["S", "1", "F"], ["S", "3", "F"]]);
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

describe("Layout mode's sheet (docs/course-layout.md §1)", () => {
  const frame = { x: 10, y: 10, width: 190, height: 277 };
  const window = { minX: -65, minY: -128.5, width: 190, height: 277 };
  const mapText = { id: "n", kind: "text" as const, anchor: "map" as const, x: 0, y: 0, text: "N", fontSizeMm: 5, color: "#000000" };
  const pageText = { id: "t", kind: "text" as const, anchor: "page" as const, x: 20, y: 20, text: "{course}", fontSizeMm: 5, color: "#000000" };
  const layout = {
    page: { paper: { heightMm: 297 }, frame, window, objects: [mapText, pageText], textValues: { course: "A" }, description: null },
    appearance: { circle: 1.2 },
    overprintScale: 1.5,
  };

  it("passes the page through and draws layout objects, appearance and print view options in the course layer, as the composer does", () => {
    const oob = { id: 7, kind: "oob_area", geometry: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], props: {}, scope: { all: true }, z: 0, version: "1", inCourses: null } as course.CourseObject;
    const r = courseLayerRequest(base({ layout, courseObjects: [oob] }));
    expect(r.page).toBe(layout.page);
    expect(r.appearance).toEqual({ circle: 1.2 });
    expect(r.viewOptions.overprintScale).toBe(1.5);
    expect(r.viewOptions.textValues).toEqual({ course: "A" });
    // The frame grown by the composer's bleed, in paper mm.
    const xs = r.viewOptions.window!.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(-66, 6);
    expect(Math.max(...xs)).toBeCloseTo(126, 6);
    // Layout objects first (both anchors; the layer draws the map-anchored ones), then the course objects.
    expect(r.objects.map((o) => o.id)).toEqual(["n", "t", 7]);
  });

  it("without a sheet: Course mode's request, no page", () => {
    const r = courseLayerRequest(base());
    expect(r.page).toBeUndefined();
    expect(r.appearance).toEqual({});
    expect(r.viewOptions.window).toBeUndefined();
  });
});
