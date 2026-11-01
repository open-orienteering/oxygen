import { describe, it, expect } from "vitest";
import { createMapGlWorker, type CourseReply, type WorkerReply } from "../../../map-gl/worker";
import { documentBytes, fontBytes, latin, request } from "../../../map-gl/__tests__/course-fixture";
import { editorHitAt, HIT_TOLERANCE_PX } from "../hit";

/** The fixture course (S 10,10 → 31 40,10 → 32 60,40 → F 10,40) through the real worker. */
function hitIndex(): NonNullable<CourseReply["hit"]> {
  const sent: WorkerReply[] = [];
  const w = createMapGlWorker((msg) => sent.push(msg), (fn) => fn(), 0);
  w.handle({
    type: "load",
    source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } },
    fonts: [{ family: "liberation-sans", bytes: fontBytes("LiberationSans-Regular.ttf") }],
    textAtlas: [latin()],
    courseLayer: true,
  });
  w.handle({ type: "course", generation: 1, input: request() });
  return (sent[sent.length - 1] as CourseReply).hit!;
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

  it("names a screen tolerance", () => {
    expect(HIT_TOLERANCE_PX).toBeGreaterThan(0);
  });
});
