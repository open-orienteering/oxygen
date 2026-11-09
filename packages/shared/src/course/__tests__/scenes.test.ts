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
import { flattenRings, pointInRings } from "../../render/geometry.js";

const SNAP_DIR = fileURLToPath(new URL("../../render/__fixtures__/streams/course/", import.meta.url));

function run(name: CourseSceneName) {
  const scene = courseScene(name);
  // The layer's regions (a corridor's band, §10.2) act on the base map only, as every backend passes them.
  const { stream, warnings } = symbolise({
    objects: scene.objects, symbols: scene.symbols, fonts: [liberation().sans, liberation().narrow],
    regions: scene.layer.regions, regionObjectLimit: scene.courseObjectOffset,
  });
  return { scene, stream, warnings };
}

function formatStream(j: PassStreamJson): string {
  const list = (xs: unknown[]) => (xs.length ? `[\n${xs.map((x) => JSON.stringify(x)).join(",\n")}\n]` : "[]");
  const masks = j.masks ? `,\n"masks": ${list(j.masks)},\n"maskIdx": ${JSON.stringify(j.maskIdx)}` : "";
  return `{\n"objectIdx": ${JSON.stringify(j.objectIdx)},\n"symbolIdx": ${JSON.stringify(j.symbolIdx)},\n"passes": ${list(j.passes)},\n"glyphTable": ${list(j.glyphTable ?? [])},\n"fontTable": ${JSON.stringify(j.fontTable)}${masks}\n}\n`;
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

  it("course-objects: the white-out at upper white over the ink, 709 / 707 / 711 upper purple, layout colour, the toner saver's white on top", () => {
    const { scene, stream } = run("course-objects");
    const passes = coursePasses(scene, stream);
    expect(passes.filter((x) => x.ref === "object:course-object:wo").map((x) => `${x.p.kind}:${x.colour}`)).toEqual(["fill:white-upper"]);
    // P1: the toner saver's ring is the stream's last pass — over upper purple and the layout text's row.
    expect(passes.filter((x) => x.ref === "object:course-object:ring").map((x) => `${x.p.kind}:${x.colour}`)).toEqual(["fill:course:toner-saver-white"]);
    expect(paletteId(scene, stream.passes.at(-1)!.colour)).toBe("course:toner-saver-white");
    const order = stream.passes.map((p) => paletteId(scene, p.colour));
    expect(order.indexOf("white-upper")).toBeGreaterThan(order.lastIndexOf("black100"));
    expect(order.indexOf("white-upper")).toBeLessThan(order.indexOf("purple-upper"));
    expect(passes.find((x) => x.ref === "object:course-object:oob")!.p.kind).toBe("hatch");
    expect(passes.filter((x) => x.ref === "object:course-object:oob-b").map((x) => x.p.kind).sort()).toEqual(["hatch", "stroke"]);
    for (const ref of ["object:course-object:oob", "object:course-object:1", "object:course-object:3"]) expect(passes.find((x) => x.ref === ref)!.colour, ref).toBe("purple-upper");
    expect(passes.find((x) => x.ref === "object:course-object:2")!.colour).toBe("purple-lower");
    const title = passes.find((x) => x.ref === "object:course-object:title")!;
    expect(title.colour).toBe("course-object:#1f6fb2");
    expect(title.p.colour).toBe(scene.colours.length - 2);
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
  it("course-leg-styles: a bent 705 through its bend, 707 dashed in upper purple over black, nothing for a none leg", () => {
    const { scene, stream } = run("course-leg-styles");
    const passes = coursePasses(scene, stream);
    const line = passes.filter((x) => x.ref === "leg:course:0");
    expect(line.map((x) => x.colour)).toEqual(["purple-lower"]);
    const coords = line[0].p.kind === "stroke" ? Array.from(line[0].p.path.coords) : [];
    expect(coords.some((v, i) => i % 2 === 0 && v === 14000 && coords[i + 1] === 20000)).toBe(true);
    const route = passes.filter((x) => x.ref === "leg:course:1");
    expect(route.length).toBeGreaterThan(0);
    expect(route.every((x) => x.colour === "purple-upper")).toBe(true);
    expect(route.reduce((n, x) => n + (x.p.kind === "stroke" ? (x.p.slices?.length ?? 1) : 0), 0)).toBeGreaterThan(3);
    const order = stream.passes.map((p) => paletteId(scene, p.colour));
    expect(Math.min(...route.map((x) => x.k))).toBeGreaterThan(order.lastIndexOf("black100"));
    expect(passes.filter((x) => x.ref === "leg:course:2")).toEqual([]);
    expect(scene.layer.derivation.courses[0].legs[2].pieces).toHaveLength(2);
    expect(scene.layer.derivation.sites.filter((s) => s.label).map((s) => s.label!.text)).toEqual(["1", "2"]);
  });
  it("course-legs-curved: a curved 705 drawn along the flattened curve, not the chord; a curved 707; the crossing on the curve (F13)", () => {
    const { scene, stream } = run("course-legs-curved");
    const passes = coursePasses(scene, stream);
    const line = passes.filter((x) => x.ref === "leg:course:1");
    expect(line.map((x) => x.colour)).toEqual(["purple-lower"]);
    const coords = line[0].p.kind === "stroke" ? Array.from(line[0].p.path.coords) : [];
    expect(coords.length).toBeGreaterThan(30);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i + 1 < coords.length; i += 2) pts.push([coords[i] / 1000, coords[i + 1] / 1000]);
    const near = (x: number, y: number) => Math.min(...pts.slice(1).map((q, i) => segDist(pts[i], q, [x, y])));
    // The first curved segment's t = 0.5 — p0 = c0 = (24, 6), c1 = (38, 7), p1 = (40, 12) — lies on the stroke.
    expect(near(31.25, 7.125)).toBeLessThan(0.005 + 0.001);
    // The bend itself is a vertex of the stroke; the chord's midpoint is far from it.
    expect(coords.some((v, i) => i % 2 === 0 && v === 40000 && coords[i + 1] === 12000)).toBe(true);
    expect(near(33, 17)).toBeGreaterThan(2);
    const route = passes.filter((x) => x.ref === "leg:course:2");
    expect(route.length).toBeGreaterThan(0);
    expect(route.every((x) => x.colour === "purple-upper")).toBe(true);
    // The crossing point sits on the curved leg as one of its vertices, turned along it.
    const leg = scene.layer.derivation.courses[0].legs[3];
    expect(leg.crossing).toBe("P");
    expect(leg.points).toContainEqual({ x: 21.5, y: 28 });
    const p = scene.layer.derivation.sites.find((s) => s.id === "P")!;
    expect(p.role).toBe("crossing_point");
    expect(p.angleDeg).not.toBe(90);
  });
  it("course-corridor: one clip region, the map masked in the band and clear inside the corridors and the mouths, the course never masked", () => {
    const { scene, stream } = run("course-corridor");
    expect(scene.layer.regions.map((r) => [r.mode, r.symbols])).toEqual([["clip", "all"]]);
    const rings = flattenRings(scene.layer.regions[0].path);
    const inBand = (x: number, y: number) => pointInRings(rings, x * 1000, y * 1000);
    // 60 m at 1:15 000 = 4 mm: S → 31's edge 2 mm off its line, its band to 5 mm.
    const mid = { x: 14, y: 7 }, n = { x: -2 / Math.hypot(16, 2), y: 16 / Math.hypot(16, 2) };
    expect(inBand(mid.x + n.x * 1, mid.y + n.y * 1)).toBe(false);
    expect(inBand(mid.x + n.x * 3.5, mid.y + n.y * 3.5)).toBe(true);
    expect(inBand(mid.x + n.x * 5.5, mid.y + n.y * 5.5)).toBe(false);
    // At 32 the 150 m corridor (5 mm half width) reaches past the narrow one's band edge (2 + 3 mm): clear.
    expect(inBand(40 - 4.5 * (20 / Math.hypot(20, 8)), 24 + 4.5 * (8 / Math.hypot(20, 8)))).toBe(false);
    // The joined bend: inside both of the 31 → 32 pieces near (36, 10) — clear.
    expect(inBand(35, 11)).toBe(false);
    // F19 mouths: 31's circle (R 2.5) clear across, past the leg's 2 mm; the band round it to R + 3.
    expect(inBand(22, 8 - 2.4)).toBe(false);
    expect(inBand(22, 8 - 4)).toBe(true);
    // The 701 (apex towards 31): clear in its back corner, beyond the leg's 2 mm; nothing behind its base.
    const back = { x: 6 - 1.5 * Math.cos(Math.atan2(2, 16)) - 2.5 * n.x, y: 6 - 1.5 * Math.sin(Math.atan2(2, 16)) - 2.5 * n.y };
    expect(inBand(back.x, back.y)).toBe(false);
    expect(inBand(6 - 2 * Math.cos(Math.atan2(2, 16)), 6 - 2 * Math.sin(Math.atan2(2, 16)))).toBe(true);
    // F22 (§10.2 "Ends"): 33 is the corridor's only end there; the band (h 5 + w 2) stops on the line through it.
    // Behind it, past the inside's round end (5 mm), the map — the band before F22; beside the leg before it, band.
    const u = { x: -20 / Math.hypot(20, 8), y: 8 / Math.hypot(20, 8) }, v = { x: -u.y, y: u.x };
    expect(inBand(20 + u.x * 6, 32 + u.y * 6)).toBe(false);
    expect(inBand(20 + u.x * 1 + v.x * 6, 32 + u.y * 1 + v.y * 6)).toBe(false);
    expect(inBand(20 - u.x * 3 + v.x * 6, 32 - u.y * 3 + v.y * 6)).toBe(true);
    expect(inBand(20 - u.x * 3 - v.x * 6, 32 - u.y * 3 - v.y * 6)).toBe(true);
    const masked = (k: number) => (stream.maskIdx?.[k] ?? -1) >= 0;
    const base = stream.passes.map((_, k) => k).filter((k) => stream.objectIdx[k] < scene.courseObjectOffset);
    // 505, 101 and 516 cross the band; the 401 fill under everything meets it too.
    expect(base.filter(masked).length).toBe(base.length);
    const passes = coursePasses(scene, stream);
    expect(passes.every((x) => !masked(x.k))).toBe(true);
    // The edge: lower purple 705/edge, round-capped, along S → 31 → 32 (legs 0 and 1), over the 401 fill.
    const edge = passes.filter((x) => x.ref.startsWith("corridor:"));
    expect(edge.length).toBeGreaterThan(0);
    expect(new Set(edge.map((x) => x.ref))).toEqual(new Set(["corridor:course:0", "corridor:course:1"]));
    expect(edge.every((x) => x.colour === "purple-lower")).toBe(true);
    expect(edge.every((x) => scene.symbols[stream.symbolIdx[x.k]].id.endsWith("705/edge"))).toBe(true);
    const fill = stream.passes.findIndex((_, k) => stream.objectIdx[k] === 0);
    expect(Math.min(...edge.map((x) => x.k))).toBeGreaterThan(fill);
    // F19 openings: 31 opens towards both legs (two arcs); 32, 33 whole; never a cut in the derivation.
    const circle = (id: string) => scene.layer.objects.filter((o) => o.ref.kind === "site" && o.ref.id === id);
    expect(circle("31").map((o) => o.path.closed)).toEqual([false, false]);
    expect(circle("32").map((o) => o.path.closed)).toEqual([true]);
    expect(circle("33").map((o) => o.path.closed)).toEqual([true]);
    expect(scene.layer.derivation.sites.every((x) => x.cuts.length === 0)).toBe(true);
    // F14: no 705 along the three corridor legs; 33 → F is the only leg line, lower purple.
    const legs = passes.filter((x) => x.ref.startsWith("leg:"));
    expect([...new Set(legs.map((x) => x.ref))]).toEqual(["leg:course:3"]);
    expect(legs.every((x) => x.colour === "purple-lower")).toBe(true);
  });
  it("course-exchange: part 2 alone — the exchange numbered as a control, numbering continued, no start", () => {
    const { scene, stream } = run("course-exchange");
    const d = scene.layer.derivation;
    expect(d.sites.map((s) => `${s.id}:${s.role}`)).toEqual(["32:control", "33:control", "F:finish"]);
    expect(d.sites.filter((s) => s.label).map((s) => s.label!.text)).toEqual(["2", "3"]);
    expect(d.courses[0].section).toEqual({ index: 1, count: 2 });
    const refs = new Set(coursePasses(scene, stream).map((x) => x.ref));
    expect(refs.has("site:32")).toBe(true);
    expect(refs.has("site:S")).toBe(false);
    expect(refs.has("site:31")).toBe(false);
  });
});

function segDist(a: [number, number], b: [number, number], p: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}
