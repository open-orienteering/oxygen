/**
 * §3.9 opacity and blend in the stream (slice J, J1): the fields travel with
 * their pass through `symbolise`, the sort, the JSON projection and the
 * comparator, and the reference SVG wraps an alpha pass in one group.
 */

import { describe, expect, it } from "vitest";
import { PILOT, pilotSymbols } from "../__fixtures__/pilot-symbols.js";
import { renderFixtures } from "../__fixtures__/streams/index.js";
import { libraryScene } from "../__fixtures__/library/index.js";
import { type Pass, makePath, passHasAlpha, sortPassStream } from "../pass-stream.js";
import { passStreamToSvg } from "../reference-svg.js";
import { diffPassStreams, passStreamFromJson, passStreamToJson } from "../stream-json.js";
import { objectAlpha, symbolise } from "../symbolise.js";
import { liberation } from "./fonts.js";

const fonts = () => [liberation().sans];
const colour = () => "#000000";

describe("§3.9 objectAlpha", () => {
  it("keeps opacity only below 1, clamps below 0, drops non-finite; blend only when multiply", () => {
    expect(objectAlpha({})).toEqual({});
    expect(objectAlpha({ opacity: 1 })).toEqual({});
    expect(objectAlpha({ opacity: 1.5 })).toEqual({});
    expect(objectAlpha({ opacity: Number.NaN })).toEqual({});
    expect(objectAlpha({ opacity: 0.4 })).toEqual({ opacity: 0.4 });
    expect(objectAlpha({ opacity: -0.2 })).toEqual({ opacity: 0 });
    expect(objectAlpha({ opacity: 0 })).toEqual({ opacity: 0 });
    expect(objectAlpha({ blend: "multiply" })).toEqual({ blend: "multiply" });
  });
});

describe("§3.9 symbolise carries opacity and blend onto every pass of the object", () => {
  it("a framed road (main, borders), an area with pattern, a text with halo: every pass", () => {
    const objects = [
      { symbolIdx: PILOT.roadFramed503, path: makePath([0, 0, 10000, 0, 20000, 5000]), opacity: 0.5, blend: "multiply" as const },
      { symbolIdx: PILOT.scatteredTrees407, path: makePath([0, 0, 10000, 0, 10000, 10000, 0, 10000], undefined, true), opacity: 0.25 },
      { symbolIdx: PILOT.controlNumber704, path: makePath([5000, 5000]), text: "12", opacity: 0.6 },
    ];
    const { stream } = symbolise({ objects, symbols: pilotSymbols, fonts: fonts() });
    expect(stream.passes.length).toBeGreaterThan(3);
    stream.passes.forEach((p, i) => {
      const obj = objects[stream.objectIdx[i]];
      expect(p.opacity, `pass ${i} (${p.kind})`).toBe(obj.opacity);
      expect(p.blend, `pass ${i} (${p.kind})`).toBe(obj.blend);
    });
  });

  it("an object without the fields gives the stream of today (no keys added)", () => {
    const obj = { symbolIdx: PILOT.roadFramed503, path: makePath([0, 0, 10000, 0]) };
    const a = symbolise({ objects: [obj], symbols: pilotSymbols, fonts: fonts() }).stream;
    const b = symbolise({ objects: [{ ...obj, opacity: 1 }], symbols: pilotSymbols, fonts: fonts() }).stream;
    for (const p of [...a.passes, ...b.passes]) {
      expect("opacity" in p).toBe(false);
      expect("blend" in p).toBe(false);
    }
    expect(diffPassStreams(a, b)).toEqual([]);
  });

  it("the library scenes carry no alpha (document objects never set one)", () => {
    const scene = libraryScene("lib-borders");
    const { stream } = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts: fonts() });
    expect(stream.passes.some(passHasAlpha)).toBe(false);
  });
});

describe("§3.9 sort, projection and comparator", () => {
  const fixture = () => passStreamFromJson(renderFixtures["alpha-passes"]);

  it("the fields travel with their pass through the canonical sort", () => {
    const s = fixture();
    const reversed = sortPassStream({ ...s, passes: [...s.passes].reverse(), objectIdx: s.objectIdx.slice().reverse(), symbolIdx: s.symbolIdx.slice().reverse() });
    expect(reversed.passes.map((p) => [p.kind, p.colour, p.opacity])).toEqual(s.passes.map((p) => [p.kind, p.colour, p.opacity]));
  });

  it("round-trips through JSON; opacity 1 parses to absent; out of range is refused", () => {
    const s = fixture();
    const j = passStreamToJson(s);
    expect(diffPassStreams(passStreamFromJson(j), s)).toEqual([]);
    expect(j.passes.filter((p) => "opacity" in p)).toHaveLength(6);
    const one = { objectIdx: [0], symbolIdx: [0], passes: [{ kind: "fill", colour: 0, opacity: 1, path: { coords: [0, 0, 1, 0, 1, 1] } }] };
    expect("opacity" in passStreamFromJson(one).passes[0]).toBe(false);
    expect(() => passStreamFromJson({ ...one, passes: [{ ...one.passes[0], opacity: 1.2 }] })).toThrow();
    expect(() => passStreamFromJson({ ...one, passes: [{ ...one.passes[0], blend: "screen" }] })).toThrow();
  });

  it("projects opacity to 4 decimals", () => {
    const s = fixture();
    const p = { ...s.passes[0], opacity: 0.123456 } as Pass;
    expect(passStreamToJson({ ...s, passes: [p], objectIdx: s.objectIdx.slice(0, 1), symbolIdx: s.symbolIdx.slice(0, 1) }).passes[0].opacity).toBe(0.1235);
  });

  it("reports an opacity and a blend difference", () => {
    const a = passStreamFromJson(renderFixtures["blend-multiply"]);
    const passes = a.passes.map((p) => (p.blend ? { ...p, blend: undefined, opacity: 0.3 } : p)) as Pass[];
    const what = diffPassStreams(a, { ...a, passes }).map((d) => d.what);
    expect(what.some((w) => w.startsWith("opacity"))).toBe(true);
    expect(what.some((w) => w.startsWith("blend multiply vs normal"))).toBe(true);
  });
});

describe("§3.9 reference SVG", () => {
  it("wraps an alpha pass in one group with opacity and mix-blend-mode, outside its clip", () => {
    const svg = passStreamToSvg(passStreamFromJson(renderFixtures["alpha-passes"]), { colour });
    expect(svg).toMatch(/<g data-alpha="\d+" opacity="0.5"><path data-pass="\d+" data-kind="fill"/);
    // The clipped glyph pass: the alpha group is outside the clip group.
    expect(svg).toMatch(/<g data-alpha="\d+" opacity="0.5"><g data-pass="\d+" data-kind="glyph" data-colour="6" clip-path=/);
    const mul = passStreamToSvg(passStreamFromJson(renderFixtures["blend-multiply"]), { colour });
    expect(mul).toContain('style="mix-blend-mode:multiply"');
    expect(mul).toMatch(/<g data-alpha="\d+" opacity="0.5" style="mix-blend-mode:multiply">/);
  });

  it("puts the alpha group outside a filter mask group", () => {
    const j = renderFixtures["alpha-passes"];
    const masks = [{ regions: [{ coords: [0, 0, 5000, 0, 5000, 5000, 0, 5000], closed: true }] }];
    const maskIdx = j.passes.map((_, i) => (i === 2 ? 0 : -1));
    const svg = passStreamToSvg(passStreamFromJson({ ...j, masks, maskIdx }), { colour });
    expect(svg).toMatch(/<g data-alpha="\d+" opacity="0.5"><g data-mask="0"/);
  });

  it("an opaque stream's SVG has no alpha attribute", () => {
    for (const name of ["fill-with-holes", "dashed-bezier-stroke", "glyph-instances", "hatch-area", "colour-order", "text-with-halo"] as const) {
      const svg = passStreamToSvg(passStreamFromJson(renderFixtures[name]), { colour });
      expect(svg).not.toContain("data-alpha");
      expect(svg).not.toContain("mix-blend-mode");
    }
  });
});
