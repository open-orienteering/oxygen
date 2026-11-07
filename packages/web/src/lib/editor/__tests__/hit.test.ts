import { describe, it, expect } from "vitest";
import { createMapGlWorker, type CourseReply, type WorkerReply } from "../../../map-gl/worker";
import { documentBytes, fontBytes, latin, request } from "../../../map-gl/__tests__/course-fixture";
import { editorHitAt, HIT_TOLERANCE_PX } from "../hit";

/** The fixture course (S 10,10 → 31 40,10 → 32 60,40 → F 10,40) through the real worker. */
function hitIndex(over: Parameters<typeof request>[0] = {}): NonNullable<CourseReply["hit"]> {
  return courseReply(over).hit!;
}

function courseReply(over: Parameters<typeof request>[0] = {}): CourseReply {
  const sent: WorkerReply[] = [];
  const w = createMapGlWorker((msg) => sent.push(msg), (fn) => fn(), 0);
  w.handle({
    type: "load",
    source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } },
    fonts: [{ family: "liberation-sans", bytes: fontBytes("LiberationSans-Regular.ttf") }],
    textAtlas: [latin()],
    courseLayer: true,
  });
  w.handle({ type: "course", generation: 1, input: request(over) });
  return sent[sent.length - 1] as CourseReply;
}

describe("editorHitAt (docs/course-editor.md §5)", () => {
  const index = hitIndex();
  const at = (x: number, y: number, tolMm = 0.5) => editorHitAt(index, { x, y }, tolMm);

  it("a control's interior and ring select the site", () => {
    expect(at(40, 10)).toEqual({ kind: "site", id: "31" });
    expect(at(42, 10.5)).toEqual({ kind: "site", id: "31" });
  });

  it("start and finish symbols select their sites", () => {
    expect(at(10, 10)).toEqual({ kind: "site", id: "S" });
    expect(at(10, 40)).toEqual({ kind: "site", id: "F" });
  });

  it("a leg selects the leg with its course and derived index", () => {
    // Leg 1 runs 31 (40,10) → 32 (60,40); its midpoint is (50, 25).
    expect(at(50, 25)).toEqual({ kind: "leg", courseId: "c1", index: 1 });
    // Leg 0 runs S → 31 along y = 10.
    expect(at(25, 10.1)).toEqual({ kind: "leg", courseId: "c1", index: 0 });
  });

  it("empty map is null; the tolerance widens the reach", () => {
    expect(at(25, 30)).toBeNull();
    expect(at(25, 11, 0)).toBeNull();
    expect(at(25, 11, 1)).toEqual({ kind: "leg", courseId: "c1", index: 0 });
  });

  it("a number selects its label", () => {
    const label = index.refs.findIndex((r) => r.kind === "number" && r.id === "31");
    expect(label).toBeGreaterThanOrEqual(0);
    // Find the text pass of that object and probe inside its first glyph box.
    const i = Array.from(index.stream.objectIdx).findIndex((o, k) => o === label && index.stream.passes[k].kind === "text");
    const p = index.stream.passes[i] as Extract<(typeof index.stream.passes)[number], { kind: "text" }>;
    const x = p.positions[0] / 1000 + 0.3, y = p.positions[1] / 1000 + 1;
    expect(at(x, y, 0)).toEqual({ kind: "number", id: "31" });
  });

  it("UI-layer sites (faded off-course controls) hit by their circle, under the layer's objects", () => {
    expect(editorHitAt(index, { x: 80, y: 80 }, 0.5, [{ id: "77", x: 80, y: 81, radiusMm: 3 }])).toEqual({ kind: "site", id: "77" });
    expect(editorHitAt(index, { x: 40, y: 10 }, 0.5, [{ id: "77", x: 40, y: 10, radiusMm: 3 }])).toEqual({ kind: "site", id: "31" });
    expect(editorHitAt(null, { x: 80, y: 80 }, 0.5, [{ id: "77", x: 80, y: 81, radiusMm: 3 }])).toEqual({ kind: "site", id: "77" });
  });

  it("`accept` passes over other targets: an armed placement sees only sites (§6.1)", () => {
    const sitesOnly = (t: { kind: string }) => t.kind === "site";
    expect(editorHitAt(index, { x: 50, y: 25 }, 0.5, [], [], sitesOnly)).toBeNull();
    expect(editorHitAt(index, { x: 40, y: 10 }, 0.5, [], [], sitesOnly)).toEqual({ kind: "site", id: "31" });
    // A rejected site lets the one below it through (the provisional circle over a reused control).
    const not31 = (t: { kind: string; id?: unknown }) => t.kind === "site" && t.id !== "31";
    expect(editorHitAt(index, { x: 40, y: 10 }, 0.5, [{ id: "77", x: 40, y: 10, radiusMm: 3 }], [], not31)).toEqual({ kind: "site", id: "77" });
  });

  it("a course object selects the object by its public id (§7)", () => {
    const withObjects = hitIndex({
      objects: [
        { id: 12, kind: "oob_area", geometry: [{ x: 70, y: 60 }, { x: 90, y: 60 }, { x: 90, y: 80 }, { x: 70, y: 80 }], props: {} },
        { id: 13, kind: "marked_route", geometry: [{ x: 70, y: 90 }, { x: 90, y: 90 }], props: {} },
      ],
    });
    // Without `uiAreas` the layer's answer stands (a fill's interior included); the viewer lists every closed kind.
    expect(editorHitAt(withObjects, { x: 80, y: 70 }, 0.5)).toEqual({ kind: "object", id: 12 });
    expect(editorHitAt(withObjects, { x: 80, y: 90.1 }, 0.5)).toEqual({ kind: "object", id: 13 });
    // The course still wins where it is drawn.
    expect(editorHitAt(withObjects, { x: 40, y: 10 }, 0.5)).toEqual({ kind: "site", id: "31" });
  });

  describe("closed areas are hit by their outline only; their interior is the map (§5)", () => {
    const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const g12 = sq(70, 60, 90, 80);
    const g14 = sq(100, 60, 120, 80);
    const g15 = sq(70, 100, 90, 120);
    const g16 = sq(0, 0, 100, 60);
    const withAreas = hitIndex({
      objects: [
        { id: 16, kind: "whiteout", geometry: g16, props: {} },
        { id: 12, kind: "oob_area", geometry: g12, props: {} },
        { id: 14, kind: "oob_area", geometry: g14, props: { border: "solid" } },
        { id: 15, kind: "whiteout", geometry: g15, props: {} },
        { id: 13, kind: "marked_route", geometry: [{ x: 70, y: 90 }, { x: 90, y: 90 }], props: {} },
      ],
    });
    const areas = [{ id: 16, ring: g16 }, { id: 12, ring: g12 }, { id: 14, ring: g14 }, { id: 15, ring: g15 }];
    const at = (x: number, y: number) => editorHitAt(withAreas, { x, y }, 0.5, [], areas);

    it("a press inside an oob_area or a white-out is the map", () => {
      expect(at(80, 70)).toBeNull();
      expect(at(80, 110)).toBeNull();
    });

    it("the outline, within the tolerance, is the object", () => {
      expect(at(80, 60.2)).toEqual({ kind: "object", id: 12 });
      expect(at(89.7, 70)).toEqual({ kind: "object", id: 12 });
      expect(at(80, 119.6)).toEqual({ kind: "object", id: 15 });
      expect(at(80, 61)).toBeNull();
    });

    it("a 709.b border does not grab the interior through the closed-stroke rule", () => {
      expect(at(110, 70)).toBeNull();
      expect(at(110, 60.1)).toEqual({ kind: "object", id: 14 });
    });

    it("a control or a leg inside an area still hits; areas sit below everything", () => {
      // Site 31 (40, 10) and leg 1's midpoint (50, 25) lie inside the white-out 16.
      expect(at(40, 10)).toEqual({ kind: "site", id: "31" });
      expect(at(50, 25)).toEqual({ kind: "leg", courseId: "c1", index: 1 });
      // A line is still hit by its stroke.
      expect(at(80, 90.1)).toEqual({ kind: "object", id: 13 });
    });
  });

  it("UI-layer areas (filter regions, toner savers) hit along the outline only, below everything", () => {
    const ring = [{ x: 0, y: 50 }, { x: 30, y: 50 }, { x: 30, y: 70 }, { x: 0, y: 70 }];
    expect(editorHitAt(index, { x: 15, y: 60 }, 0.5, [], [{ id: 5, ring }])).toBeNull();
    expect(editorHitAt(index, { x: 30.3, y: 60 }, 0.5, [], [{ id: 5, ring }])).toEqual({ kind: "object", id: 5 });
    expect(editorHitAt(index, { x: 31, y: 60 }, 0.5, [], [{ id: 5, ring }])).toBeNull();
    expect(editorHitAt(index, { x: 40, y: 10 }, 0.5, [], [{ id: 5, ring: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] }]))
      .toEqual({ kind: "site", id: "31" });
  });

  it("a circle with a stored gap is open arcs: its centre hits only through the UI-layer circle (§5)", () => {
    const base = request();
    const gapped = hitIndex({ sites: base.sites.map((x) => (x.id === "31" ? { ...x, circleGaps: [{ start: 40, end: 100 }] } : x)) });
    expect(editorHitAt(gapped, { x: 40, y: 10 }, 0.1)).toBeNull();
    expect(editorHitAt(gapped, { x: 40, y: 10 }, 0.1, [{ id: "31", x: 40, y: 10, radiusMm: 2.5 }])).toEqual({ kind: "site", id: "31" });
  });

  it("a corridor's edge is no target (course-layer.md §10.2); its band reaches the static buckets' filter", () => {
    // Leg 0 (S → 31, y = 10) with a 60 m corridor at 1:15 000: the edge at y = 12, the band to 15.
    const corridor = { widthM: 60, edge: true, whiteMm: 3, whiteOpacity: 1 };
    const structure = { version: 1 as const, id: "c1", orderMode: "ordered" as const, items: [{ siteId: "S" }, { siteId: "31", leg: { corridor } }, { siteId: "32" }, { siteId: "F" }] };
    const reply = courseReply({ structure });
    expect(reply.hit!.refs.some((r) => r.kind === "corridor")).toBe(true);
    expect(editorHitAt(reply.hit!, { x: 20, y: 12 }, 0.5)).toBeNull();
    expect(editorHitAt(reply.hit!, { x: 20, y: 10.1 }, 0.5)).toEqual({ kind: "leg", courseId: "c1", index: 0 });
    // The document's black line crosses the band: masked in the static buckets.
    expect(reply.filter).not.toBeNull();
    expect(reply.filter!.masks.length).toBeGreaterThan(0);
    expect(courseReply().filter).toBeNull();
  });

  it("names a screen tolerance", () => {
    expect(HIT_TOLERANCE_PX).toBeGreaterThan(0);
  });
});
