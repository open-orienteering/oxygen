/** The dynamic bucket through the worker (docs/map-rendering.md §5.2 "Dynamic bucket"). */

import { describe, it, expect } from "vitest";
import { COURSE_BUCKET, PAGE_BUCKET, createMapGlWorker, type CourseLayerRequest, type CourseReply, type LoadedReply, type LoadRequest, type WorkerReply } from "../worker";
import { buildVisibleSet, type PreparedPart, type ResidentPart } from "../buckets";
import { INSTANCE_FLOATS } from "../mesh-atlas";
import { render } from "@oxygen/shared";

import { documentBytes, fontBytes, indexOf, isomStack, latin, request } from "./course-fixture";

function harness() {
  const sent: { msg: WorkerReply; transfer: ArrayBuffer[] }[] = [];
  const w = createMapGlWorker((msg, transfer) => sent.push({ msg, transfer }), (fn) => fn(), 0);
  return { w, sent };
}

const load = (over: Partial<LoadRequest> = {}): LoadRequest => ({
  type: "load",
  source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } },
  fonts: [{ family: "liberation-sans", bytes: fontBytes("LiberationSans-Regular.ttf") }],
  textAtlas: [latin()],
  courseLayer: true,
  ...over,
});

/** Every colour of a part's range tables. */
function partColours(p: PreparedPart): Set<number> {
  const out = new Set<number>();
  for (const k of [p.fill, p.hatch, p.stroke, p.glyph, p.text]) for (const c of k?.ranges.colour ?? []) out.add(c);
  return out;
}

function loaded(w: ReturnType<typeof harness>, req = load()): LoadedReply {
  w.w.handle(req);
  return w.sent[w.sent.length - 1].msg as LoadedReply;
}

describe("course-layer load (docs/map-rendering.md §5.2 Dynamic bucket)", () => {
  it("keys the static buckets on the course-completed stack: upper white below upper purple, rows above moved up one", () => {
    const h = harness();
    const m = loaded(h);
    const doc = isomStack();
    const stack = m.summary.colourStack!;
    expect(stack).toHaveLength(doc.length + 1);
    const upper = indexOf(stack, "purple-upper");
    expect(stack[upper - 1].id).toBe("iof2024:white-upper");
    expect(m.summary.courseLayer).toEqual({ supported: true, cutFeatures: 0 });
    // The black line keeps its index (below upper purple); the top-row line moved up one, same CMYK.
    const black = indexOf(doc, "black100");
    const colours = new Set<number>();
    for (const p of [...m.base, ...(m.large ? [m.large] : [])]) for (const c of partColours(p)) colours.add(c);
    h.w.handle({ type: "prepare", ids: m.summary.detailCells });
    for (const s of h.sent.slice(1)) if (s.msg.type === "part") for (const c of partColours(s.msg.part)) colours.add(c);
    expect(colours).toEqual(new Set([black, doc.length]));
    expect(stack[doc.length].cmyk).toEqual(doc[doc.length - 1].cmyk);
    expect(stack[black].cmyk).toEqual(doc[black].cmyk);
  });

  it("without `courseLayer` the stack is the document's (dev page, bench)", () => {
    const m = loaded(harness(), load({ courseLayer: false }));
    expect(m.summary.colourStack).toEqual(isomStack());
    expect(m.summary.courseLayer).toBeUndefined();
  });

  it("an unaligned stack: the document draws unchanged and the course layer is unsupported", () => {
    const colours = isomStack().filter((c) => !c.id.includes("purple"));
    const m = loaded(harness(), load({ source: { kind: "document", bytes: documentBytes(colours), options: { unmatched: "proxy" } } }));
    expect(m.summary.colourStack).toEqual(colours);
    expect(m.summary.courseLayer?.supported).toBe(false);
  });
});

describe("course request → the dynamic bucket", () => {
  const ask = (h: ReturnType<typeof harness>, input: CourseLayerRequest | null, generation = 1): CourseReply => {
    h.w.handle({ type: "course", generation, input });
    const r = h.sent[h.sent.length - 1];
    expect(r.msg.type).toBe("course");
    return r.msg as CourseReply;
  };

  it("one `all` part on the completed stack, object ids after the document's, glyph meshes appended to the atlas", () => {
    const h = harness();
    const m = loaded(h);
    const r = ask(h, request(), 7);
    expect(r.generation).toBe(7);
    expect(r.warnings).toEqual({});
    const part = r.part!;
    expect(part.bucket).toBe(COURSE_BUCKET);
    expect(part.layer).toBe("all");
    const stack = r.colours;
    expect(stack).toEqual(m.summary.colourStack);
    const lower = indexOf(stack, "purple-lower");
    // 703 arcs and 705 legs: lower-purple strokes; 704 numbers (upper purple on both libraries) as text instances.
    expect([...part.stroke!.ranges.colour].every((c) => c === lower)).toBe(true);
    expect(part.text!.instances.length / INSTANCE_FLOATS).toBe(2);
    // 701 / 706 are glyphs whose meshes the reply's atlas holds.
    const atlas = r.atlas!;
    expect(atlas.meshes.length).toBeGreaterThan(m.atlas.meshes.length);
    for (let i = 0; i < part.glyph!.instances.length; i += INSTANCE_FLOATS) {
      const base = part.glyph!.instances[i + 5];
      expect(atlas.meshes.some((mm) => mm.base === base)).toBe(true);
    }
    // Earlier meshes keep their place.
    m.atlas.meshes.forEach((mm, i) => expect(atlas.meshes[i]).toEqual(mm));
    const docObjects = m.summary.objects.total;
    for (const k of [part.stroke!, part.glyph!, part.text!]) for (const o of k.ranges.object) expect(o).toBeGreaterThanOrEqual(docObjects);
    expect(r.derivation!.sites.map((s) => s.id)).toEqual(["S", "31", "32", "F"]);
    expect(r.metrics!.circleRadiusMm).toBeGreaterThan(2);
    // Everything transferable.
    expect(h.sent[h.sent.length - 1].transfer).toContain(atlas.data.buffer);
  });

  it("carries the layer's hit index: the symbolised stream (local object ids) and each object's ref (§5.5)", () => {
    const h = harness();
    loaded(h);
    const r = ask(h, request());
    const hit = r.hit!;
    expect(hit.stream.passes.length).toBeGreaterThan(0);
    expect(Math.max(...hit.stream.objectIdx)).toBeLessThan(hit.refs.length);
    const kinds = new Set(hit.refs.map((ref) => ref.kind));
    expect(kinds).toEqual(new Set(["site", "leg", "number"]));
    // Control 31 sits at (40, 10) mm: its circle is the topmost site hit there (interior counts).
    const hits = render.hitTest(hit.stream, 40_000, 10_000, { toleranceUm: 0, closedStrokeInterior: true });
    expect(hits.map((x) => hit.refs[x.objectIdx]).find((ref) => ref.kind === "site")).toEqual({ kind: "site", id: "31" });
    expect(ask(h, null).hit).toBeNull();
  });

  it("the same layer again adds no mesh: no atlas in the reply", () => {
    const h = harness();
    loaded(h);
    ask(h, request(), 1);
    const moved = request({ sites: request().sites.map((s) => (s.id === "31" ? { ...s, x: 45 } : s)) });
    const r = ask(h, moved, 2);
    expect(r.atlas).toBeUndefined();
    expect(r.part).not.toBeNull();
  });

  it("draws in colour order with the static parts: lower purple under black", () => {
    const h = harness();
    const m = loaded(h);
    h.w.handle({ type: "prepare", ids: m.summary.detailCells });
    const parts: PreparedPart[] = [...m.base, ...(m.large ? [m.large] : [])];
    for (const s of h.sent.slice(1)) if (s.msg.type === "part") parts.push(s.msg.part);
    const r = ask(h, request());
    parts.push(r.part!);
    const resident: ResidentPart[] = parts.map((part) => ({ part, base: { fill: 0, hatch: 0, stroke: 0 } }));
    const vs = buildVisibleSet(resident);
    const order = vs.stroke.draws.map((d) => d.colour);
    expect(order.indexOf(indexOf(r.colours, "purple-lower"))).toBeLessThan(order.indexOf(indexOf(r.colours, "black100")));
  });

  it("null clears; an unsupported document answers no part with COURSE_UNAVAILABLE", () => {
    const h = harness();
    loaded(h);
    expect(ask(h, null).part).toBeNull();
    const u = harness();
    loaded(u, load({ courseLayer: false }));
    const r = ask(u, request());
    expect(r.part).toBeNull();
    expect(r.warnings).toEqual({ COURSE_UNAVAILABLE: 1 });
  });

  it("a whiteout layout object sits at upper white, above black", () => {
    const h = harness();
    loaded(h);
    const r = ask(h, request({ objects: [{ id: "w1", kind: "path", anchor: "map", fillMode: "whiteout", closed: true, points: [{ x: 20, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 15 }, { x: 20, y: 15 }] }] }));
    const fill = r.part!.fill!;
    const white = indexOf(r.colours, "purple-upper") - 1;
    expect([...fill.ranges.colour]).toContain(white);
    expect(white).toBeGreaterThan(indexOf(r.colours, "black100"));
  });
});

describe("course request with a page → the page part (docs/course-layout.md §1)", () => {
  const ask = (h: ReturnType<typeof harness>, input: CourseLayerRequest | null): CourseReply => {
    h.w.handle({ type: "course", generation: 1, input });
    return h.sent[h.sent.length - 1].msg as CourseReply;
  };
  // A4 portrait, frame 10 mm in, the window centred on (30, 10) paper mm at the map's own scale.
  const frame = { x: 10, y: 10, width: 190, height: 277 };
  const window = { minX: 30 - 95, minY: 10 - 138.5, width: 190, height: 277 };
  const page = (over: Partial<NonNullable<CourseLayerRequest["page"]>> = {}): NonNullable<CourseLayerRequest["page"]> => ({
    paper: { heightMm: 297 },
    frame,
    window,
    objects: [
      { id: "t", kind: "text", anchor: "page", x: 105, y: 20, text: "Bana", fontSizeMm: 6, color: "#000000" },
      { id: "w", kind: "rectangle", anchor: "page", x: 150, y: 250, width: 30, height: 20, fillMode: "whiteout" },
    ],
    description: null,
    ...over,
  });

  it("no page: no page part, the stack as before", () => {
    const h = harness();
    loaded(h);
    const r = ask(h, request());
    expect(r.pagePart).toBeNull();
    expect(r.page).toBeNull();
  });

  it("one part after every map colour: page colours start at `colourBase`, the table repeated for them", () => {
    const h = harness();
    loaded(h);
    const r = ask(h, request({ page: page() }));
    const part = r.pagePart!;
    expect(part.bucket).toBe(PAGE_BUCKET);
    const base = r.page!.colourBase;
    expect(r.colours).toHaveLength(2 * base);
    for (const c of partColours(part)) expect(c).toBeGreaterThanOrEqual(base);
    for (const c of partColours(r.part!)) expect(c).toBeLessThan(base);
    // The page white-out takes the stack's upper white, in the page's copy of the table.
    const white = indexOf(r.colours, "purple-upper") - 1;
    expect(partColours(part)).toContain(base + white);
    expect(r.colours[base + white].cmyk).toEqual(r.colours[white].cmyk);
    expect(r.colours[base + white].id).not.toBe(r.colours[white].id);
  });

  it("page objects land in paper µm through T_map⁻¹: the text near the paper point under its page position", () => {
    const h = harness();
    const m = loaded(h);
    const r = ask(h, request({ page: page() }));
    const text = r.pagePart!.text!;
    expect(text.instances.length).toBeGreaterThan(0);
    // Page (105, 20) y-down → y-up 277 → map: centre (30, 10) + (105 − 105, 277 − 148.5) = (30, 138.5) mm.
    const x = text.instances[0] + m.summary.originX, y = text.instances[1] + m.summary.originY;
    expect(Math.abs(x - 30000)).toBeLessThan(15000);
    expect(Math.abs(y - 138500)).toBeLessThan(8000);
  });

  it("the frame ring in paper µm for the map clip", () => {
    const h = harness();
    loaded(h);
    const r = ask(h, request({ page: page() }));
    const ring = r.page!.frameRingUm;
    expect(ring).toHaveLength(4);
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-65000, 0);
    expect(Math.max(...xs)).toBeCloseTo(125000, 0);
    expect(Math.min(...ys)).toBeCloseTo(-128500, 0);
    expect(Math.max(...ys)).toBeCloseTo(148500, 0);
  });

  it("the description block draws on the page", () => {
    const h = harness();
    loaded(h);
    const rows = [{ kind: "control" as const, sequence: 1, code: "31" }];
    const r = ask(h, request({ page: page({ objects: [], description: { x: 140, y: 14, cellSizeMm: 7, rows, title: "A" } }) }));
    expect(r.pagePart).not.toBeNull();
    expect(partColours(r.pagePart!).size).toBeGreaterThan(0);
  });
});

describe("course request → filter regions over the static buckets (§5.2 Filter regions)", () => {
  const ask = (h: ReturnType<typeof harness>, input: CourseLayerRequest | null, generation = 1): CourseReply => {
    h.w.handle({ type: "course", generation, input });
    return h.sent[h.sent.length - 1].msg as CourseReply;
  };
  // Over the black document line at x = 25 mm (paper mm, y-up); away from every course object's own ids.
  const square = [{ x: 20, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 15 }, { x: 20, y: 15 }];
  const far = [{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }];

  it("hide: the document object meeting the region, exact and fast alike; never a course object", () => {
    const h = harness();
    const m = loaded(h);
    const exact = ask(h, request({ regions: [{ rings: [square], mode: "hide", symbols: "all" }] }));
    expect(Array.from(exact.filter!.hidden)).toEqual([0]);
    expect(exact.filter!.entries).toHaveLength(0);
    const fast = ask(h, request({ regions: [{ rings: [square], mode: "hide", symbols: "all" }], fastFilter: true }), 2);
    expect(Array.from(fast.filter!.hidden)).toEqual([0]);
    expect(Array.from(ask(h, request({ regions: [{ rings: [far], mode: "hide", symbols: "all" }] }), 3).filter!.hidden)).toEqual([]);
    expect(m.summary.objects.total).toBe(2);
  });

  it("clip by document colour: (object, colour, mask) entries on the completed stack and the region's triangles, origin-relative", () => {
    const h = harness();
    const m = loaded(h);
    const black = indexOf(isomStack(), "black100");
    const r = ask(h, request({ regions: [{ rings: [square], mode: "clip", symbols: { colours: [black] } }] }));
    expect(Array.from(r.filter!.entries)).toEqual([0, black, 0]);
    expect(r.filter!.masks).toEqual([{ offset: 0, count: 6 }]);
    const xs = Array.from(r.filter!.positions).filter((_, i) => i % 2 === 0).map((x) => x + m.summary.originX);
    expect(Math.min(...xs)).toBe(20_000);
    expect(Math.max(...xs)).toBe(30_000);
    // The visible set puts the black line's stroke under the mask; the course part stays unmasked.
    const resident = (p: PreparedPart): ResidentPart => ({ part: p, base: { fill: 0, hatch: 0, stroke: 0 } });
    h.w.handle({ type: "prepare", ids: m.summary.detailCells });
    const detail = h.sent.flatMap((s) => (s.msg.type === "part" ? [resident(s.msg.part)] : []));
    const entryMask = new Map([[0 * 65536 + black, 0]]);
    const vs = buildVisibleSet([...detail, resident(r.part!)], undefined, { entryMask, positions: r.filter!.positions, indices: r.filter!.indices, masks: r.filter!.masks });
    expect(vs.stroke.draws.filter((d) => d.mask === 0).map((d) => d.colour)).toEqual([black]);
    expect(vs.stroke.draws.some((d) => d.mask === undefined)).toBe(true);
  });

  it("no regions, or a cleared layer: no filter", () => {
    const h = harness();
    loaded(h);
    expect(ask(h, request()).filter).toBeNull();
    expect(ask(h, null, 2).filter).toBeNull();
  });
});
