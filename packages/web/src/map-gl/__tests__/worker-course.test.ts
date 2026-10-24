/** The dynamic bucket through the worker (docs/map-rendering.md §5.2 "Dynamic bucket"). */

import { describe, it, expect } from "vitest";
import { COURSE_BUCKET, createMapGlWorker, type CourseLayerRequest, type CourseReply, type LoadedReply, type LoadRequest, type WorkerReply } from "../worker";
import { buildVisibleSet, type PreparedPart, type ResidentPart } from "../buckets";
import { INSTANCE_FLOATS } from "../mesh-atlas";

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
