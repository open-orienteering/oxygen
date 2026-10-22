import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@oxygen/shared";
import { createMapGlWorker, type LoadedReply, type LoadRequest, type WorkerReply } from "../worker";
import { buildVisibleSet, type PreparedPart, type ResidentPart } from "../buckets";
import { INSTANCE_FLOATS } from "../mesh-atlas";
import { parseTextAtlasPage, type TextAtlasPage } from "../text-atlas";

const fontsDir = resolve(import.meta.dirname, "../../../../shared/fonts");
const fontBytes = (file: string) => {
  const b = readFileSync(resolve(fontsDir, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** The pilot scene, tiled so it spans several 50 mm cells, plus a long line for the large bucket. */
function objects(): render.RenderObject[] {
  const out: render.RenderObject[] = [];
  for (const [dx, dy] of [[0, 0], [70_000, 0], [0, 70_000]]) {
    for (const o of render.pilotScene) {
      const c = Int32Array.from(o.path.coords);
      for (let i = 0; i < c.length; i += 2) { c[i] += dx; c[i + 1] += dy; }
      out.push({ ...o, path: { ...o.path, coords: c } });
    }
  }
  out.push({ symbolIdx: render.PILOT.contour101, path: render.makePath([0, -5000, 300_000, -5000]) });
  return out;
}

const atlasPage = (page: string): TextAtlasPage =>
  parseTextAtlasPage(JSON.parse(readFileSync(resolve(fontsDir, `msdf/text-atlas.${page}.json`), "utf8")));

function harness() {
  const sent: { msg: WorkerReply; transfer: ArrayBuffer[] }[] = [];
  const tasks: (() => void)[] = [];
  const w = createMapGlWorker((msg, transfer) => sent.push({ msg, transfer }), (fn) => tasks.push(fn), 0);
  const runTask = () => tasks.shift()?.();
  return { w, sent, tasks, runTask };
}

const load = () => ({
  type: "load" as const,
  source: { kind: "objects" as const, objects: objects(), symbols: render.pilotSymbols },
  fonts: [{ family: "liberation-sans" as const, bytes: fontBytes("LiberationSans-Regular.ttf") }],
});

describe("worker protocol (docs/map-rendering.md §5.2 Worker)", () => {
  it("load replies with the summary, the atlas and the always-resident layers, all buffers transferable", () => {
    const { w, sent } = harness();
    w.handle(load());
    expect(sent).toHaveLength(1);
    const { msg, transfer } = sent[0];
    expect(msg.type).toBe("loaded");
    const m = msg as LoadedReply;
    expect(m.summary.passes).toBeGreaterThan(0);
    expect(m.summary.objects.large).toBe(1);
    expect(m.large).toBeDefined();
    expect(m.large!.layer).toBe("all");
    expect(m.base.length).toBeGreaterThan(1);
    for (const p of m.base) {
      expect(p.layer).toBe("base");
      expect(p.stroke ?? p.glyph ?? p.text).toBeUndefined();
    }
    expect(m.summary.detailCells.length).toBeGreaterThan(1);
    expect(m.atlas.meshes.length).toBeGreaterThan(0);
    // Every typed array of the reply is in the transfer list (no copies across the worker boundary).
    expect(transfer).toContain(m.atlas.data.buffer);
    for (const p of m.base) expect(transfer).toContain(p.fill!.indices.buffer);
    expect(new Set(transfer).size).toBe(transfer.length);
    // The origin is inside the grid, positions are stored relative to it.
    const g = m.summary.grid;
    expect(m.summary.originX).toBeGreaterThanOrEqual(g.minCol * g.cellUm);
    expect(m.summary.originX).toBeLessThanOrEqual((g.minCol + g.cols) * g.cellUm);
  });

  it("prepare replies one detail part per wanted cell, one per task with a zero slice, and a newer request replaces the queue", () => {
    const { w, sent, tasks, runTask } = harness();
    w.handle(load());
    const cells = (sent[0].msg as LoadedReply).summary.detailCells;
    expect(cells.length).toBeGreaterThanOrEqual(3);
    w.handle({ type: "prepare", ids: cells.slice(0, 3) });
    expect(tasks).toHaveLength(1);
    runTask();
    expect(sent.filter((s) => s.msg.type === "part")).toHaveLength(1);
    w.handle({ type: "prepare", ids: [cells[cells.length - 1]] });
    while (tasks.length) runTask();
    const parts = sent.filter((s) => s.msg.type === "part").map((s) => (s.msg as Extract<WorkerReply, { type: "part" }>).part);
    expect(parts.map((p) => p.bucket)).toEqual([cells[0], cells[cells.length - 1]]);
    for (const p of parts) {
      expect(p.layer).toBe("detail");
      expect(p.fill ?? p.hatch).toBeUndefined();
      expect(p.ms).toBeGreaterThanOrEqual(0);
    }
    expect(w.queued).toBe(0);
  });

  it("base + detail of every cell + the large bucket draw every pass the stream has", () => {
    const { w, sent, tasks, runTask } = harness();
    w.handle(load());
    const m = sent[0].msg as LoadedReply;
    w.handle({ type: "prepare", ids: m.summary.detailCells });
    while (tasks.length) runTask();
    const parts = [...m.base, m.large!, ...sent.slice(1).map((s) => (s.msg as Extract<WorkerReply, { type: "part" }>).part)];
    const resident: ResidentPart[] = parts.map((part) => ({ part, base: { fill: 0, hatch: 0, stroke: 0 } }));
    const vs = buildVisibleSet(resident);
    // Pilot scene: fills, hatches, strokes and glyphs in several colours, all present.
    expect(vs.fill.draws.length).toBeGreaterThan(0);
    expect(vs.hatch.draws.length).toBeGreaterThan(0);
    expect(vs.stroke.draws.length).toBeGreaterThan(0);
    expect(vs.glyph.draws.length + vs.clips.groups.length).toBeGreaterThan(0);
    // One draw per (colour, kind): no colour appears twice in a kind's draw list.
    for (const k of [vs.fill, vs.hatch, vs.stroke]) expect(new Set(k.draws.map((d) => d.colour)).size).toBe(k.draws.length);
  });

  it("a first view queues its detail without a round trip; below the zoom gate it queues nothing", () => {
    const { w, sent, tasks, runTask } = harness();
    w.handle({ ...load(), firstView: { kind: "fit", widthPx: 2000, heightPx: 2000 } });
    const m = sent[0].msg as LoadedReply;
    expect(m.summary.view).toBeDefined();
    expect(m.summary.queued.length).toBeGreaterThan(0);
    expect(m.summary.queued.every((id) => m.summary.detailCells.includes(id))).toBe(true);
    while (tasks.length) runTask();
    expect(sent.slice(1).map((s) => (s.msg as Extract<WorkerReply, { type: "part" }>).part.bucket)).toEqual(m.summary.queued);

    const gated = harness();
    gated.w.handle({ ...load(), firstView: { kind: "fit", widthPx: 20, heightPx: 20 } }); // ~1e-4 px/µm
    expect((gated.sent[0].msg as LoadedReply).summary.queued).toEqual([]);
    expect(gated.tasks).toHaveLength(0);
  });

  it("reports a load failure as an error reply", () => {
    const { w, sent } = harness();
    w.handle({ type: "load", source: { kind: "document", bytes: new ArrayBuffer(8), options: {} }, fonts: [] });
    expect(sent[0].msg.type).toBe("error");
    w.handle({ type: "prepare", ids: [0] });
    expect(sent.filter((s) => s.msg.type === "part")).toHaveLength(0);
  });

  describe("text against the text atlas (§5.2 \"Text atlas\")", () => {
    /** Loads, prepares every detail cell and returns the reply and all parts with text. */
    function run(extra: Partial<LoadRequest> = {}, objs = objects()) {
      const { w, sent, tasks, runTask } = harness();
      w.handle({ ...load(), source: { kind: "objects", objects: objs, symbols: render.pilotSymbols }, ...extra });
      const loaded = sent[0].msg as LoadedReply;
      w.handle({ type: "prepare", ids: loaded.summary.detailCells });
      while (tasks.length) runTask();
      const parts: PreparedPart[] = [...loaded.base, ...(loaded.large ? [loaded.large] : [])];
      for (const r of sent) if (r.msg.type === "part") parts.push(r.msg.part);
      return { summary: loaded.summary, text: parts.flatMap((p) => (p.text ? [p.text] : [])) };
    }
    const textPasses = (objs: render.RenderObject[]) => objs.filter((o) => o.text).length;

    it("without pages: no text drawn, TEXT_ATLAS_MISSING per text pass", () => {
      const { summary, text } = run();
      expect(text).toHaveLength(0);
      expect(summary.warnings.TEXT_ATLAS_MISSING).toBe(summary.passKinds.text);
      expect(summary.passKinds.text).toBeGreaterThanOrEqual(textPasses(objects()));
      expect(summary.text).toEqual({ pages: [], glyphs: 0, missing: 0 });
    });

    it("with the Latin page: one instance per glyph, entries into the page, halo passes carry their halo", () => {
      const { summary, text } = run({ textAtlas: [atlasPage("latin")] });
      expect(summary.warnings.TEXT_ATLAS_MISSING).toBeUndefined();
      expect(summary.text.pages).toEqual(["latin"]);
      expect(summary.text.missing).toBe(0);
      const instances = text.reduce((n, t) => n + t.instances.length / INSTANCE_FLOATS, 0);
      expect(instances).toBe(summary.text.glyphs);
      expect(instances).toBeGreaterThan(0);
      for (const t of text) {
        expect([...t.ranges.group].every((g) => g === 0)).toBe(true);
        for (let i = 0; i < t.instances.length; i += INSTANCE_FLOATS) {
          expect(Number.isInteger(t.instances[i + 5])).toBe(true);
          expect(t.instances[i + 4]).toBeGreaterThan(0);
        }
      }
      const halos = text.flatMap((t) => { const h: number[] = []; for (let i = 6; i < t.instances.length; i += INSTANCE_FLOATS) h.push(t.instances[i]); return h; });
      expect(halos.some((h) => h > 0)).toBe(true);
      expect(halos.every((h) => h <= 0.125)).toBe(true);
    });

    it("Cyrillic: not held by the Latin page (counted), drawn from page 1 when it is loaded", () => {
      const objs = [{ symbolIdx: render.PILOT.controlNumber704, path: render.makePath([26_000, 36_000]), text: "ЖA" }];
      const latinOnly = run({ textAtlas: [atlasPage("latin")] }, objs);
      expect(latinOnly.summary.warnings.TEXT_GLYPH_NOT_IN_ATLAS).toBe(latinOnly.summary.passKinds.text);
      const both = run({ textAtlas: [atlasPage("latin"), atlasPage("cyrillic")] }, objs);
      expect(both.summary.warnings.TEXT_GLYPH_NOT_IN_ATLAS).toBeUndefined();
      expect(both.summary.text.pages).toEqual(["latin", "cyrillic"]);
      const groups = new Set(both.text.flatMap((t) => [...t.ranges.group]));
      expect(groups).toEqual(new Set([0, 1]));
    });
  });
});
