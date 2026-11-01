/**
 * Course scenes (docs/map-rendering.md §6.1, §6.3; course-layer.md
 * "Tests"): each symbolises warning-free, matches its committed stream
 * snapshot (`render/__fixtures__/streams/course/<name>.stream.json`,
 * `diffPassStreams` at 1 µm), and shows the rule it is about. Regenerate
 * the snapshots only when a rule change is intended:
 * `UPDATE_STREAMS=1 pnpm --filter @oxygen/shared exec vitest run src/course/__tests__/scenes.test.ts`,
 * then review the diff and re-render the goldens.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CourseScene, type CourseSceneName, courseScene, courseSceneNames } from "../../render/__fixtures__/course/index.js";
import { type Pass, type PassStream } from "../../render/pass-stream.js";
import { diffPassStreams, passStreamFromJson, passStreamToJson, type PassStreamJson } from "../../render/stream-json.js";
import { symbolise } from "../../render/symbolise.js";
import { liberation } from "../../render/__tests__/fonts.js";

const SNAP_DIR = fileURLToPath(new URL("../../render/__fixtures__/streams/course/", import.meta.url));

function run(name: CourseSceneName) {
  const scene = courseScene(name);
  const { stream, warnings } = symbolise({ objects: scene.objects, symbols: scene.symbols, fonts: [liberation().sans, liberation().narrow] });
  return { scene, stream, warnings };
}

function formatStream(j: PassStreamJson): string {
  const list = (xs: unknown[]) => (xs.length ? `[\n${xs.map((x) => JSON.stringify(x)).join(",\n")}\n]` : "[]");
  return `{\n"objectIdx": ${JSON.stringify(j.objectIdx)},\n"symbolIdx": ${JSON.stringify(j.symbolIdx)},\n"passes": ${list(j.passes)},\n"glyphTable": ${list(j.glyphTable ?? [])},\n"fontTable": ${JSON.stringify(j.fontTable)}\n}\n`;
}

function matchSnapshot(name: CourseSceneName, stream: PassStream): void {
  const file = `${SNAP_DIR}${name}.stream.json`;
  if (process.env.UPDATE_STREAMS) {
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(file, formatStream(passStreamToJson(stream)));
  }
  expect(existsSync(file), `missing ${name}.stream.json — see the header of this file`).toBe(true);
  expect(diffPassStreams(passStreamFromJson(JSON.parse(readFileSync(file, "utf8"))), stream)).toEqual([]);
}

const paletteId = (scene: CourseScene, colour: number) => scene.colours[colour].id.replace(/^iof20\d\d:/, "");
/** Passes of course objects with their reference. */
function coursePasses(scene: CourseScene, stream: PassStream): { p: Pass; k: number; ref: string; colour: string }[] {
  const out: { p: Pass; k: number; ref: string; colour: string }[] = [];
  stream.passes.forEach((p, k) => {
    const o = stream.objectIdx[k] - scene.courseObjectOffset;
    if (o < 0) return;
    const ref = scene.layer.objects[o].ref;
    out.push({ p, k, ref: `${ref.kind}:${ref.id}`, colour: paletteId(scene, p.colour) });
  });
  return out;
}

describe("course scenes", () => {
  for (const name of courseSceneNames) {
    it(`${name}: symbolises warning-free and matches its stream snapshot`, () => {
      const { scene, stream, warnings } = run(name);
      expect(warnings).toEqual([]);
      expect(scene.layer.warnings).toEqual([]);
      matchSnapshot(name, stream);
    });
  }

  it("course-legs: lower purple below black, brown and blue line art; start turned; sequence numbers", () => {
    const { scene, stream } = run("course-legs");
    const order = stream.passes.map((p) => paletteId(scene, p.colour));
    const lastLower = order.lastIndexOf("purple-lower");
    for (const ink of ["black100", "brown100-line", "blue100-line"]) expect(order.indexOf(ink), ink).toBeGreaterThan(lastLower);
    expect(order.indexOf("yellow100")).toBeLessThan(order.indexOf("purple-lower"));
    const start = scene.layer.derivation.sites.find((s) => s.id === "S")!;
    expect(start.angleDeg).toBeCloseTo((Math.atan2(6, 18) * 180) / Math.PI - 90, 9);
    expect(scene.layer.derivation.sites.filter((s) => s.label).map((s) => s.label!.text)).toEqual(["1", "2", "3"]);
  });

  it("course-cuts: automatic cuts at document features, authored gap and pieces, manual number", () => {
    const { scene, stream } = run("course-cuts");
    const sites = new Map(scene.layer.derivation.sites.map((s) => [s.id, s]));
    expect(sites.get("31")!.cuts).toHaveLength(1); // boulder on the east rim
    expect(sites.get("32")!.cuts).toHaveLength(1); // knoll on the north rim
    expect(sites.get("33")!.cuts).toEqual([{ start: 300, end: 330 }]);
    const legs = scene.layer.derivation.courses[0].legs;
    expect(legs[1].gaps).toHaveLength(1); // boulder on 31 → 32
    expect(legs[2].gaps).toEqual([{ from: 0.4, to: 0.6 }]); // authored: replaces the automatic ones
    expect(sites.get("33")!.label).toMatchObject({ x: 44, y: 3 });
    // Each cut circle is open arcs, not a closed ring.
    const arcs = coursePasses(scene, stream).filter((x) => x.ref === "site:31" && x.p.kind === "stroke");
    expect(arcs.every((x) => x.p.kind === "stroke" && !x.p.path.closed)).toBe(true);
  });

  it("course-objects: white-outs at upper white over the ink, 709 / 707 / 711 upper purple, layout colour on top", () => {
    const { scene, stream } = run("course-objects");
    const passes = coursePasses(scene, stream);
    const whiteout = passes.filter((x) => x.ref === "object:wo" || x.ref === "object:ring");
    expect(whiteout.map((x) => `${x.p.kind}:${x.colour}`)).toEqual(["fill:white-upper", "fill:white-upper"]);
    const order = stream.passes.map((p) => paletteId(scene, p.colour));
    expect(order.indexOf("white-upper")).toBeGreaterThan(order.lastIndexOf("black100"));
    expect(order.indexOf("white-upper")).toBeLessThan(order.indexOf("purple-upper"));
    expect(passes.find((x) => x.ref === "object:oob")!.p.kind).toBe("hatch");
    expect(passes.filter((x) => x.ref === "object:oob-b").map((x) => x.p.kind).sort()).toEqual(["hatch", "stroke"]);
    for (const ref of ["object:oob", "object:course-object:1", "object:course-object:3"]) expect(passes.find((x) => x.ref === ref)!.colour, ref).toBe("purple-upper");
    expect(passes.find((x) => x.ref === "object:course-object:2")!.colour).toBe("purple-lower");
    const title = passes.find((x) => x.ref === "object:title")!;
    expect(title.colour).toBe("course-object:#1f6fb2");
    expect(title.p.colour).toBe(scene.colours.length - 1);
  });

  it("course-sprint: 6 mm circles, knockout numbers above the building", () => {
    const { scene, stream } = run("course-sprint");
    const passes = coursePasses(scene, stream);
    const text = passes.filter((x) => x.p.kind === "text");
    expect(text.map((x) => x.colour).sort()).toEqual(["purple-upper", "purple-upper", "white-upper", "white-upper"]);
    const order = stream.passes.map((p) => paletteId(scene, p.colour));
    expect(order.lastIndexOf("black100")).toBeGreaterThan(0);
    expect(order.indexOf("white-upper")).toBeGreaterThan(order.lastIndexOf("black100"));
    const ring = passes.find((x) => x.ref === "site:31" && x.p.kind === "stroke")!.p;
    if (ring.kind !== "stroke") throw new Error("ring");
    expect(Math.max(...Array.from(ring.path.coords).filter((_, i) => i % 2 === 1))).toBe(22000 + 3000);
  });

  it("course-all-controls: every site, codes, no legs, start north", () => {
    const { scene } = run("course-all-controls");
    const d = scene.layer.derivation;
    expect(d.sites.map((s) => s.id)).toEqual(["S", "41", "57", "63", "F", "42", "100"]);
    expect(d.courses[0].legs).toEqual([]);
    expect(d.sites.filter((s) => s.label).map((s) => s.label!.text)).toEqual(["41", "57", "63", "42", "100"]);
    expect(d.sites[0].angleDeg).toBeUndefined();
  });
});
