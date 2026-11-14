/**
 * The edit part (docs/map-rendering.md §5.5 "Document objects"; row G5): the selected objects'
 * passes redrawn in the highlight colour, and a draft — patch ops being edited — drawn in its own
 * colours with its targets' static copies hidden.
 */

import { describe, it, expect } from "vitest";
import { mapDocument, render } from "@oxygen/shared";
import {
  createMapGlWorker, EDIT_BUCKET, EDIT_OBJECT_BASE, highlightPasses, HIGHLIGHT_COLOUR, HIGHLIGHT_OUTLINE_UM,
  type EditInput, type EditReply, type LoadedReply, type PatchedReply, type WorkerReply,
} from "../worker";
import type { PreparedPart } from "../buckets";
import { ADD1, CELL_UM, documentBytes, index, moveLine1, patchOf, T } from "./patch-fixture";

function loaded(patch?: mapDocument.MapPatch | null) {
  const sent: WorkerReply[] = [];
  const w = createMapGlWorker((msg) => sent.push(msg), () => undefined, 0);
  w.handle({ type: "load", source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" }, ...(patch !== undefined ? { patch } : {}) }, fonts: [], cellUm: CELL_UM });
  const reply = sent[0] as LoadedReply;
  expect(reply.type).toBe("loaded");
  return { w, sent, summary: reply.summary };
}

let gen = 0;
function edit(h: ReturnType<typeof loaded>, input: EditInput | null): EditReply {
  const before = h.sent.length;
  h.w.handle({ type: "edit", generation: ++gen, input });
  const m = h.sent[before];
  if (m.type !== "edit") throw new Error(`expected edit, got ${JSON.stringify(m)}`);
  expect(m.generation).toBe(gen);
  return m;
}
function patch(h: ReturnType<typeof loaded>, p: mapDocument.MapPatch | null): PatchedReply {
  const before = h.sent.length;
  h.w.handle({ type: "patch", generation: ++gen, patch: p, detail: [] });
  const m = h.sent[before];
  if (m.type !== "patched") throw new Error(`expected patched, got ${JSON.stringify(m)}`);
  return m;
}

/** Colours of a part's entries per kind. */
function colours(p: PreparedPart | null) {
  const of = (k: { ranges: { colour: Uint16Array } } | undefined) => [...new Set(k?.ranges.colour ?? [])];
  return { fill: of(p?.fill), hatch: of(p?.hatch), stroke: of(p?.stroke), glyph: of(p?.glyph), text: of(p?.text) };
}
function objects(p: PreparedPart | null): number[] {
  const s = new Set<number>();
  for (const k of [p?.fill, p?.hatch, p?.stroke, p?.glyph, p?.text]) for (const o of k?.ranges.object ?? []) s.add(o);
  return [...s].sort((a, b) => a - b);
}
/** x of the stroke vertices of `colour`, paper µm. */
function strokeXs(p: PreparedPart | null, originX: number, colour: number): number[] {
  const k = p!.stroke!;
  const v = new Float32Array(k.verts);
  const xs: number[] = [];
  for (let e = 0; e < k.ranges.colour.length; e++) {
    if (k.ranges.colour[e] !== colour) continue;
    // 16-byte vertices: x, y (f32, origin-relative), then the offset and half width.
    for (let i = k.ranges.start[e]; i < k.ranges.start[e] + k.ranges.count[e]; i++) xs.push(Math.round(v[4 * k.indices[i]] + originX));
  }
  return xs;
}
const near = (xs: number[], x: number, d: number) => xs.length > 0 && xs.every((v) => Math.abs(v - x) <= d);

describe("highlight through the dynamic bucket (§5.5 'Document objects')", () => {
  it("redraws a selected line's passes in the highlight colour under edit-part ids", () => {
    const h = loaded();
    const e = edit(h, { selected: [{ source: 1 }] });
    expect(e.part?.bucket).toBe(EDIT_BUCKET);
    expect(colours(e.part).stroke).toEqual([HIGHLIGHT_COLOUR]);
    expect(objects(e.part).every((o) => o >= EDIT_OBJECT_BASE)).toBe(true);
    expect(e).toMatchObject({ selected: [index(1)], highlighted: 1, issues: [] });
    expect([...e.hidden]).toEqual([]);
    expect(near(strokeXs(e.part, h.summary.originX, HIGHLIGHT_COLOUR), 5000, 200)).toBe(true);
  });

  it("an area is highlighted by its outline, not flooded", () => {
    const h = loaded();
    const e = edit(h, { selected: [{ source: 3 }] });
    expect(colours(e.part)).toMatchObject({ fill: [], hatch: [], stroke: [HIGHLIGHT_COLOUR] });
    // The outline: vertices along the area's edges x = 21 and 29 mm.
    const xs = strokeXs(e.part, h.summary.originX, HIGHLIGHT_COLOUR);
    expect(xs.every((x) => Math.abs(x - 21_000) <= 200 || Math.abs(x - 29_000) <= 200 || (x > 21_000 && x < 29_000))).toBe(true);
    expect(xs.some((x) => Math.abs(x - 21_000) <= 200)).toBe(true);
  });

  it("a point's glyph instances are redrawn in the highlight colour", () => {
    const h = loaded();
    const e = edit(h, { selected: [{ source: 4 }] });
    expect(colours(e.part)).toMatchObject({ glyph: [HIGHLIGHT_COLOUR], stroke: [] });
  });

  it("several selected objects, an unknown one and a patch-hidden one", () => {
    const h = loaded(patchOf([{ op: "hide", sourceIndex: 2 }]));
    const e = edit(h, { selected: [{ source: 1 }, { source: 99 }, { source: 2 }, { source: 4 }, { added: ADD1 }] });
    expect(e.selected).toEqual([index(1), -1, -1, index(4), -1]);
    expect(e.highlighted).toBe(2);
    expect(objects(e.part)).toHaveLength(2);
  });

  it("null and an empty selection clear the part", () => {
    const h = loaded();
    edit(h, { selected: [{ source: 1 }] });
    expect(edit(h, null)).toMatchObject({ part: null, selected: [], highlighted: 0 });
    expect(edit(h, { selected: [] })).toMatchObject({ part: null, selected: [] });
  });

  it("an added object is selected by its add id", () => {
    const h = loaded(patchOf([{ op: "add", id: ADD1, type: T.line, symbol: { doc: 0 }, coords: [[1200, 500], [1800, 500]] }]));
    const e = edit(h, { selected: [{ added: ADD1 }] });
    expect(e.selected).toEqual([6]);
    expect(colours(e.part).stroke).toEqual([HIGHLIGHT_COLOUR]);
  });

  it("highlightPasses: text redrawn, its halo left out, a fill and a clipped pattern as outlines", () => {
    const square = render.makePath([0, 0, 1000, 0, 1000, 1000, 0, 1000], undefined, true);
    const b = new render.PassStreamBuilder();
    b.push({ kind: "fill", colour: 0, path: square, rule: "evenodd" }, 0, 0);
    b.push({ kind: "glyph", colour: 1, glyphId: 0, partIdx: 0, instances: Float32Array.from([500, 500, 1, 0, 1]), clip: square }, 0, 0);
    b.push({ kind: "text", colour: 2, fontId: 0, sizeUm: 1000, glyphs: Uint16Array.from([1]), positions: Float32Array.from([0, 0]), haloWidthUm: 200 }, 0, 0);
    b.push({ kind: "text", colour: 3, fontId: 0, sizeUm: 1000, glyphs: Uint16Array.from([1]), positions: Float32Array.from([0, 0]) }, 0, 0);
    const s = b.build();
    const glyphs = { entries: Int32Array.from([4]), pages: Uint8Array.from([0]), haloEm: 0 };
    const out = highlightPasses(s, [0, 1, 2, 3], new Map([[3, glyphs]]), 77);
    expect(out.stream.passes.map((p) => p.kind)).toEqual(["stroke", "stroke", "text"]);
    expect(out.stream.passes.every((p) => p.colour === HIGHLIGHT_COLOUR)).toBe(true);
    expect((out.stream.passes[0] as render.StrokePass).widthUm).toBe(HIGHLIGHT_OUTLINE_UM);
    expect([...out.stream.objectIdx]).toEqual([77, 77, 77]);
    expect(out.textGlyph.get(2)).toBe(glyphs);
  });
});

describe("an object under edit: drawn from the dynamic bucket, hidden in its static one (§5.5)", () => {
  it("a modify draft draws the object at its new place in its own colour and hides its static copy", () => {
    const h = loaded();
    const e = edit(h, { selected: [], draft: { ops: [moveLine1(7)] } });
    expect([...e.hidden]).toEqual([index(1)]);
    expect(colours(e.part).stroke).toEqual([1]);
    expect(near(strokeXs(e.part, h.summary.originX, 1), 7000, 200)).toBe(true);
    expect(objects(e.part).every((o) => o >= EDIT_OBJECT_BASE)).toBe(true);
    expect(e.issues).toEqual([]);
  });

  it("a new add has no static copy; a selected draft object is highlighted where the draft draws it", () => {
    const h = loaded();
    const add: mapDocument.PatchOp = { op: "add", id: ADD1, type: T.line, symbol: { doc: 0 }, coords: [[1200, 500], [1800, 500]] };
    const e = edit(h, { selected: [{ added: ADD1 }], draft: { ops: [add] } });
    expect([...e.hidden]).toEqual([]);
    expect(e.selected).toEqual([-1]);
    expect(e.highlighted).toBe(1);
    expect(colours(e.part).stroke.sort()).toEqual([1, HIGHLIGHT_COLOUR]);

    const m = edit(h, { selected: [{ source: 1 }], draft: { ops: [moveLine1(7)] } });
    expect(m.selected).toEqual([index(1)]);
    expect(near(strokeXs(m.part, h.summary.originX, HIGHLIGHT_COLOUR), 7000, 200)).toBe(true);
  });

  it("a draft over the drawn patch: an add being edited hides the drawn add; a hide draft hides and draws nothing", () => {
    const add = (x: number): mapDocument.PatchOp => ({ op: "add", id: ADD1, type: T.line, symbol: { doc: 0 }, coords: [[x, 500], [x + 600, 500]] });
    const h = loaded(patchOf([add(1200)]));
    const e = edit(h, { selected: [], draft: { ops: [add(1300)] } });
    expect([...e.hidden]).toEqual([6]);
    // Drawn from 13 to 19 mm (the draft's place), not from 12 mm (the drawn add's).
    const xs = strokeXs(e.part, h.summary.originX, 1);
    expect(xs.length > 0 && xs.every((x) => x >= 12_800 && x <= 19_200)).toBe(true);
    const hide = edit(h, { selected: [{ source: 1 }], draft: { ops: [{ op: "hide", sourceIndex: 1 }] } });
    expect([...hide.hidden]).toEqual([index(1)]);
    expect(hide.part).toBeNull();
  });

  it("reports the draft's own issues only", () => {
    const h = loaded();
    const e = edit(h, { selected: [], draft: { ops: [{ op: "modify", sourceIndex: 99, coords: [[0, 0], [100, 0]] }] } });
    expect(e.issues).toEqual([{ opId: "modify:99", code: "target-missing" }]);
    expect(e.part).toBeNull();
  });

  it("a draft's glyph joins the mesh atlas: the reply carries it", () => {
    const h = loaded();
    const e = edit(h, { selected: [], draft: { ops: [{ op: "add", id: ADD1, type: T.point, symbol: { doc: 2 }, coords: [[1500, 500]] }] } });
    expect(e.atlas?.meshes.length).toBeGreaterThan(0);
    expect(colours(e.part).glyph).toEqual([1]);
  });

  it("a patch change carries the edit state against the new effective document", () => {
    const h = loaded(patchOf([{ op: "add", id: ADD1, type: T.line, symbol: { doc: 0 }, coords: [[1200, 500], [1800, 500]] }]));
    expect(edit(h, { selected: [{ added: ADD1 }, { source: 1 }] }).selected).toEqual([6, index(1)]);
    const p = patch(h, patchOf([{ op: "hide", sourceIndex: 1 }]));
    expect(p.edit).toMatchObject({ selected: [-1, -1], highlighted: 0, part: null });
    const q = patch(h, null);
    expect(q.edit).toMatchObject({ selected: [-1, index(1)], highlighted: 1 });
    edit(h, null);
    expect(patch(h, patchOf([{ op: "hide", sourceIndex: 2 }])).edit).toBeUndefined();
  });

  it("a request before the load answers error with its generation; after the load it is answered", () => {
    const sent: WorkerReply[] = [];
    const w = createMapGlWorker((msg) => sent.push(msg), () => undefined, 0);
    w.handle({ type: "edit", generation: 5, input: { selected: [{ source: 1 }] } });
    expect(sent[0]).toMatchObject({ type: "error", edit: 5 });
    w.handle({ type: "load", source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } }, fonts: [], cellUm: CELL_UM });
    w.handle({ type: "edit", generation: 6, input: { selected: [{ source: 1 }] } });
    expect(sent[2]).toMatchObject({ type: "edit", generation: 6, highlighted: 1 });
  });
});
