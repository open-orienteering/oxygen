/**
 * The layered colour stack (docs/map-symbols.md §9.3 "Layers", row I3):
 * one row per (source colour, role), in the palette's order, every
 * reference re-indexed. Synthetic tables in a badly ordered source order
 * and symbols shaped like the corpus cases; no club map geometry.
 */

import { describe, expect, it } from "vitest";
import { courseColourStack } from "../../course/colour-stack.js";
import type { DocumentColour } from "../../map-document/header.js";
import { parseRenderSymbol, type RenderSymbol } from "../../render/symbol.js";
import { reindexRenderColours, renderColourPaths } from "../../render/transform.js";
import { type PaletteEdition, palettes, type SpecId } from "../../symbol-library/palette.js";
import { alignmentPalette, identifySourceColours, OVERLAY_STACK_IDS, paletteIndexOfStack } from "../colour-align.js";
import { buildColourLayers, type ColourLayersResult, type LayerSymbol, symbolColourUses } from "../colour-layers.js";
import { rolePalette } from "../colour-roles.js";
import { documentSymbolFingerprints } from "../decisions.js";

const sym = (input: Record<string, unknown>): RenderSymbol => parseRenderSymbol({ id: "s", code: "1", name: "s", ...input });
const disc = (colour: number) => ({ kind: "disc" as const, colour, diameterUm: 200 });

/** The CMYK of a palette row, so a test colour classifies as that row. */
const ink = (id: string, edition: PaletteEdition = "iof2022") => [...palettes[edition].find((p) => p.id === id)!.cmyk] as DocumentColour["cmyk"];
const colour = (n: number, name: string, cmyk: DocumentColour["cmyk"]): DocumentColour => ({ id: `src:${n}`, name, cmyk, sourceNumber: n });

/**
 * An ISOM table in a deliberately bad source order (index 0 drawn first):
 * a purple at the bottom, the black under everything, one brown 50 % for
 * paved areas and road infill, a white, a red, and colours no symbol uses.
 */
const isomColours: DocumentColour[] = [
  colour(10, "Violett", [0.35, 0.85, 0, 0]),
  colour(11, "Svart", [0, 0, 0, 1]),
  colour(12, "Brun 50%", ink("brown50-paved")),
  colour(13, "Gul", ink("yellow100")),
  colour(14, "Svart 50%", ink("black50-building")),
  colour(15, "Brun", ink("brown100-line")),
  colour(16, "Vit", [0, 0, 0, 0]),
  colour(17, "Röd", [0, 1, 1, 0]),
  colour(18, "Blå", ink("blue100-line")),
  colour(19, "Logga yta", [0.6, 0.6, 0, 0]),
];

interface Sym extends LayerSymbol {
  objects: number;
}

const isomSymbols: Sym[] = [
  // 0: paved area — brown 50 % fill, black dots, a black border round the brown (the road outline).
  { objects: 5, render: sym({ type: "area", fill: 2, patterns: [{ glyph: { parts: [disc(1)], rotatable: false }, cellWidthUm: 500, cellHeightUm: 500 }], border: { main: { colour: 1, widthUm: 100 } } }) },
  // 1: road — black outlines over a brown 50 % infill.
  { objects: 7, render: sym({ type: "line", borders: { left: { colour: 1, widthUm: 140, shiftUm: 290 }, right: { colour: 1, widthUm: 140, shiftUm: 290 }, backgroundColour: 2 } }) },
  // 2: building — black 50 % with a black edge.
  { objects: 3, render: sym({ type: "area", fill: 4, border: { main: { colour: 1, widthUm: 180 } } }) },
  // 3: contour.
  { objects: 10, render: sym({ type: "line", main: { colour: 5, widthUm: 140 } }) },
  // 4: open land.
  { objects: 4, render: sym({ type: "area", fill: 3 }) },
  // 5: a white area (no role: whites take one from a hint only).
  { objects: 1, render: sym({ type: "area", fill: 6 }) },
  // 6: a red frame bar of a graphic object (no role).
  { objects: 2, origin: "graphic", render: sym({ type: "line", main: { colour: 7, widthUm: 500 } }) },
  // 7: a brown point no object uses.
  { objects: 0, render: sym({ type: "point", glyph: { parts: [disc(5)], rotatable: false } }) },
  // 8: no render.
  { objects: 3 },
];

function build(colours: DocumentColour[], symbols: Sym[], needed: string[] = [], spec: SpecId = "ISOM2017-2", edition: PaletteEdition = "iof2022"): ColourLayersResult {
  const infos = identifySourceColours(colours, spec, edition);
  const uses = symbolColourUses(symbols, symbols.map((s) => s.objects), infos, rolePalette(spec, edition));
  return buildColourLayers({ colours, infos, uses, needed: new Set(needed), spec, edition });
}

/** Each row as `role` (or `none:<place>`) @ source number (or `+` for an inserted row). */
const describeRows = (r: ColourLayersResult) =>
  r.report.rows.map((row) => `${row.role ?? `none:${row.place}`}@${row.source === null ? "+" : r.colours[row.row].sourceNumber}`);

const rowOfRole = (r: ColourLayersResult, role: string, source?: number) =>
  r.report.rows.find((row) => row.role === role && (source === undefined || row.source === source))!.row;

/** The stack `build(isomColours, isomSymbols, …)` gives, bottom first. */
const EXPECTED = [
  "yellow100@13",
  "green60-area@+",
  "green100-area@+",
  "brown50-paved@12",
  "blue100-area@18",
  "black50-building@14",
  "black-road-outline@11",
  "brown50-road@12",
  "none:area@16",
  "none:area@19",
  "white-skio@+",
  "purple-lower@+",
  "brown100-line@15",
  "blue100-line@18",
  "brown100-point@15",
  "black100@11",
  "orange-skio@+",
  "green-skio@+",
  "none:other@10",
  "none:other@17",
  "purple-upper@+",
];

describe("buildColourLayers: rows and order", () => {
  const r = build(isomColours, isomSymbols, ["blue100-area", "green60-area", "brown100-line"]);

  it("splits one brown 50 % into the paved area and the road infill: same ink and number, ids src:n and src:n/<id>", () => {
    const paved = r.colours[rowOfRole(r, "brown50-paved")];
    const road = r.colours[rowOfRole(r, "brown50-road")];
    expect(paved).toMatchObject({ id: "src:12", name: "Brun 50%", sourceNumber: 12, cmyk: isomColours[2].cmyk, paletteIds: ["brown50-paved"] });
    expect(road).toMatchObject({ id: "src:12/brown50-road", name: "Brun 50%", sourceNumber: 12, cmyk: isomColours[2].cmyk, paletteIds: ["brown50-road"] });
    expect(r.report.split).toContainEqual({ source: 2, sourceNumber: 12, roles: ["brown50-paved", "brown50-road"] });
  });

  it("puts the road outline over the paved brown and under the infill, the buildings over the paved brown", () => {
    expect(rowOfRole(r, "brown50-paved")).toBeLessThan(rowOfRole(r, "black50-building"));
    expect(rowOfRole(r, "black50-building")).toBeLessThan(rowOfRole(r, "black-road-outline"));
    expect(rowOfRole(r, "black-road-outline")).toBeLessThan(rowOfRole(r, "brown50-road"));
  });

  it("keeps the colours of a split colour on their own rows: one black as dots, road outline and black 100 %", () => {
    expect(r.report.split).toContainEqual({ source: 1, sourceNumber: 11, roles: ["black-road-outline", "black100"] });
    expect(r.colours[rowOfRole(r, "black-road-outline")].id).toBe("src:11");
    expect(r.colours[rowOfRole(r, "black100")].id).toBe("src:11/black100");
  });
});


describe("buildColourLayers: the stack", () => {
  const r = build(isomColours, isomSymbols, ["blue100-area", "green60-area", "brown100-line"]);

  it("is the expected stack, bottom first", () => {
    expect(describeRows(r)).toEqual(EXPECTED);
  });

  it("carries each palette id on exactly one row", () => {
    const ids = r.colours.flatMap((c) => c.paletteIds ?? []);
    expect(new Set(ids).size).toBe(ids.length);
    const index = paletteIndexOfStack(r.colours);
    for (const id of ["blue100-area", "green60-area", "brown100-line", "purple-lower", "purple-upper", ...OVERLAY_STACK_IDS]) expect(index.has(id), id).toBe(true);
  });

  it("aliases a needed id to a same-class source colour's ink (a row of its own), inserts one with no such colour at the palette's ink", () => {
    const blue = r.colours[rowOfRole(r, "blue100-area")];
    expect(blue).toMatchObject({ sourceNumber: 18, cmyk: isomColours[8].cmyk, paletteIds: ["blue100-area"] });
    expect(r.report.aliased).toContainEqual({ paletteId: "blue100-area", viaPaletteId: "blue100-line", sourceNumber: 18 });
    const green = r.colours[rowOfRole(r, "green60-area")];
    expect(green).toEqual({ id: "iof2022:green60-area", name: palettes.iof2022.find((p) => p.id === "green60-area")!.name, cmyk: ink("green60-area"), paletteIds: ["green60-area"] });
    expect(r.report.inserted).toContain("green60-area");
  });

  it("keeps a colour no symbol references once: at its identified place carrying its id, else by the kind its name states", () => {
    // "Blå" is used by nothing: kept as blue100-line, and the alias split it.
    expect(r.report.rows.find((x) => x.role === "blue100-line")).toMatchObject({ source: 8, origin: "unreferenced", objects: 0 });
    expect(r.report.split).toContainEqual({ source: 8, sourceNumber: 18, roles: ["blue100-area", "blue100-line"] });
    // An unclassified colour no symbol uses whose name says area ("yta") goes with the areas that have no role.
    expect(r.report.rows.find((x) => x.source === 9)).toMatchObject({ role: null, place: "area", origin: "unreferenced" });
  });

  it("gives a zero-object symbol's colour its row (Map mode may draw it), with no objects", () => {
    expect(r.report.rows.find((x) => x.role === "brown100-point")).toMatchObject({ source: 5, origin: "use", objects: 0, symbols: 1 });
  });

  it("places uses with no role by kind: an area directly under the ski mask row, anything else directly under upper purple", () => {
    const white = r.report.rows.find((x) => x.source === 6)!;
    expect(white).toMatchObject({ role: null, place: "area", objects: 1 });
    // The no-role areas (the white, then the unused "Logga yta"), in source order, directly under the mask row.
    expect(white.row + 2).toBe(rowOfRole(r, "white-skio"));
    expect(rowOfRole(r, "white-skio") + 1).toBe(rowOfRole(r, "purple-lower"));
    const red = r.report.rows.find((x) => x.source === 7)!;
    expect(red).toMatchObject({ role: null, place: "other", objects: 2, graphicObjects: 2 });
    expect(r.report.noRole).toEqual([
      { row: white.row, source: 6, sourceNumber: 16, place: "area", objects: 1 },
      { row: red.row, source: 7, sourceNumber: 17, place: "other", objects: 2 },
    ]);
    expect(rowOfRole(r, "purple-upper")).toBe(r.colours.length - 1);
  });

  it("inserts both course purples in the map's purple ink; the source purple stays an ordinary colour", () => {
    const lower = r.colours[rowOfRole(r, "purple-lower")];
    const upper = r.colours[rowOfRole(r, "purple-upper")];
    expect(lower).toMatchObject({ id: "iof2022:purple-lower", cmyk: [0.35, 0.85, 0, 0], purpleRole: "lower", paletteIds: ["purple-lower"] });
    expect(upper).toMatchObject({ id: "iof2022:purple-upper", cmyk: [0.35, 0.85, 0, 0], purpleRole: "upper", paletteIds: ["purple-upper"] });
    expect(r.report.purpleInk).toBe(0);
    expect(r.colours.filter((c) => c.purpleRole)).toHaveLength(2);
    // The unused "Violett" is kept once with no role (a course purple candidate stands for no id).
    expect(r.report.rows.find((x) => x.source === 0)).toMatchObject({ role: null, place: "other", origin: "unreferenced" });
  });

  it("puts the overlay's rows at their palette places: the track inks above black 100 %, orange under green, under upper purple", () => {
    expect(rowOfRole(r, "black100")).toBeLessThan(rowOfRole(r, "orange-skio"));
    expect(rowOfRole(r, "orange-skio") + 1).toBe(rowOfRole(r, "green-skio"));
    expect(rowOfRole(r, "green-skio")).toBeLessThan(rowOfRole(r, "purple-upper"));
    expect(rowOfRole(r, "green100-area")).toBeLessThan(rowOfRole(r, "purple-lower"));
  });

  it("is a stack the course layer accepts", () => {
    const course = courseColourStack(r.colours);
    expect(course.index.get("purple-upper")).toBeGreaterThan(course.index.get("purple-lower")!);
  });
});

describe("buildColourLayers: re-index", () => {
  const r = build(isomColours, isomSymbols, ["blue100-area"]);

  it("re-indexes per reference: the paved area's black is a road outline at its border and black 100 % in its dots", () => {
    const paved = reindexRenderColours(isomSymbols[0].render!, r.reindex.symbols[0]!);
    expect(renderColourPaths(paved).map((x) => x.colour)).toEqual([rowOfRole(r, "brown50-paved"), rowOfRole(r, "black100"), rowOfRole(r, "black-road-outline")]);
    const road = reindexRenderColours(isomSymbols[1].render!, r.reindex.symbols[1]!);
    expect(renderColourPaths(road).map((x) => x.colour)).toEqual([rowOfRole(r, "black-road-outline"), rowOfRole(r, "black-road-outline"), rowOfRole(r, "brown50-road")]);
  });

  it("maps every reference to a row of its own source colour, and each colour to its lowest row", () => {
    isomSymbols.forEach((s, i) => {
      if (!s.render) return expect(r.reindex.symbols[i]).toBeNull();
      const refs = renderColourPaths(s.render);
      r.reindex.symbols[i]!.forEach((row, k) => expect(r.report.rows[row].source).toBe(refs[k].colour));
    });
    isomColours.forEach((_, c) => {
      const mine = r.report.rows.filter((x) => x.source === c).map((x) => x.row);
      expect(r.reindex.colours[c]).toBe(Math.min(...mine));
    });
  });

  it("leaves every symbol's fingerprint unchanged (split rows keep the colour's class)", () => {
    const before = documentSymbolFingerprints({ source: { kind: "ocad" }, colours: isomColours, symbols: isomSymbols.map((s, i) => ({ code: String(i), render: s.render ?? null })) });
    const after = documentSymbolFingerprints({
      source: { kind: "ocad" },
      colours: r.colours,
      symbols: isomSymbols.map((s, i) => ({ code: String(i), render: s.render ? reindexRenderColours(s.render, r.reindex.symbols[i]!) : null })),
    });
    expect(after).toEqual(before);
    expect(before.filter(Boolean).length).toBe(8);
  });
});

describe("buildColourLayers: ties, purples, specs, determinism", () => {
  it("keeps two colours of one role in source order and hangs the palette id on the most used, ties to the lowest", () => {
    const colours = [colour(1, "Gul A", ink("yellow100")), colour(2, "Gul B", ink("yellow100"))];
    const area = (c: number, objects: number): Sym => ({ objects, render: sym({ type: "area", fill: c }) });
    const tie = build(colours, [area(0, 2), area(1, 2)]);
    expect(describeRows(tie).slice(0, 2)).toEqual(["yellow100@1", "yellow100@2"]);
    expect(tie.colours[0].paletteIds).toEqual(["yellow100"]);
    expect(tie.colours[1].paletteIds).toBeUndefined();
    const more = build(colours, [area(0, 1), area(1, 3)]);
    expect(describeRows(more).slice(0, 2)).toEqual(["yellow100@1", "yellow100@2"]);
    expect(more.colours[1].paletteIds).toEqual(["yellow100"]);
    expect(more.colours[0].paletteIds).toBeUndefined();
  });

  it("puts a source purple a hint names under the inserted course row of that role; the course ink is the most used candidate, ties to the highest", () => {
    const colours = [colour(1, "Violett A", [0.35, 0.85, 0, 0]), colour(2, "Svart", [0, 0, 0, 1]), colour(3, "Violett B", [0.2, 0.9, 0, 0])];
    // An out-of-bounds area (ISOM 709) drawn in the source's purple: its hint is upper purple.
    const oob: Sym = { objects: 4, render: sym({ type: "area", fill: 0 }), match: { canonicalId: "ISOM2017-2:709" } };
    const black: Sym = { objects: 1, render: sym({ type: "line", main: { colour: 1, widthUm: 100 } }) };
    const r = build(colours, [oob, black]);
    const purpleRows = r.report.rows.filter((x) => x.role === "purple-upper");
    expect(purpleRows.map((x) => x.source)).toEqual([0, null]);
    expect(r.colours[purpleRows[0].row].paletteIds).toBeUndefined();
    expect(r.colours[purpleRows[0].row].purpleRole).toBeUndefined();
    expect(r.colours[purpleRows[1].row]).toMatchObject({ purpleRole: "upper", cmyk: [0.35, 0.85, 0, 0] });
    expect(purpleRows[1].row).toBe(r.colours.length - 1);
    // Both candidates unused: the highest index gives the ink.
    const unused = build(colours, [black]);
    expect(unused.colours[rowOfRole(unused, "purple-lower")].cmyk).toEqual([0.2, 0.9, 0, 0]);
    // No purple at all: the palette's.
    const none = build([colours[1]], [{ ...black, render: sym({ type: "line", main: { colour: 0, widthUm: 100 } }) }]);
    expect(none.colours[rowOfRole(none, "purple-lower")].cmyk).toEqual(ink("purple-lower"));
    expect(none.report.purpleInk).toBeNull();
  });

  it("orders by the spec's own palette: the contour brown above lower purple on ISOM, below it on ISSprOM", () => {
    const colours = [colour(1, "Brun", ink("brown100-line", "iof2024"))];
    const contour: Sym = { objects: 1, render: sym({ type: "line", main: { colour: 0, widthUm: 140 } }) };
    const isom = build(colours, [contour], [], "ISOM2017-2", "iof2024");
    expect(rowOfRole(isom, "brown100-line")).toBeGreaterThan(rowOfRole(isom, "purple-lower"));
    const sprint = build(colours, [contour], [], "ISSprOM2019-2", "iof2024");
    expect(rowOfRole(sprint, "brown100")).toBeLessThan(rowOfRole(sprint, "purple-lower"));
    // Every row of either stack is in its alignment palette's order.
    for (const [res, spec] of [[isom, "ISOM2017-2"], [sprint, "ISSprOM2019-2"]] as const) {
      const rank = new Map(alignmentPalette("iof2024", spec).reverse().map((p, i) => [p.id, i]));
      const ranks = res.report.rows.filter((x) => x.role).map((x) => rank.get(x.role!)!);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it("gives the ISSkiOM rows a ski map identifies their own role and keeps them out of aliasing", () => {
    const colours = [colour(1, "Svart", [0, 0, 0, 1]), colour(2, "Grön skidspår", [0.91, 0, 0.83, 0])];
    const track: Sym = { objects: 3, render: sym({ type: "line", main: { colour: 1, widthUm: 600 } }) };
    const r = build(colours, [track], ["green100-area"]);
    expect(r.report.rows.find((x) => x.role === "green-skio")).toMatchObject({ source: 1, origin: "use", objects: 3 });
    // green 100 % area is needed and the only green is the ski green: inserted, not aliased to it.
    expect(r.report.inserted).toContain("green100-area");
    expect(r.report.aliased).toEqual([]);
  });

  it("is deterministic: the same input gives the same output", () => {
    const a = build(isomColours, isomSymbols, ["blue100-area", "green60-area"]);
    const b = build(isomColours.map((c) => ({ ...c })), isomSymbols.map((s) => ({ ...s })), ["green60-area", "blue100-area"]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("does not change its input", () => {
    const colours = isomColours.map((c) => ({ ...c, cmyk: [...c.cmyk] as DocumentColour["cmyk"] }));
    const copy = JSON.stringify(colours);
    build(colours, isomSymbols);
    expect(JSON.stringify(colours)).toBe(copy);
  });

  it("rejects a reference outside the colour table and infos of another table", () => {
    const bad: Sym = { objects: 1, render: sym({ type: "area", fill: 12 }) };
    expect(() => build(isomColours, [bad])).toThrow(/colour index 12/);
    const infos = identifySourceColours(isomColours, "ISOM2017-2", "iof2022");
    expect(() => buildColourLayers({ colours: isomColours.slice(1), infos, uses: [], needed: new Set(), spec: "ISOM2017-2", edition: "iof2022" })).toThrow(/infos/);
  });
});

describe("buildColourLayers: ids, aliases and inks", () => {
  it("splits a no-role colour drawn by an area and a line into two rows, ids src:n and src:n/none:other", () => {
    const colours = [colour(1, "Röd", [0, 1, 1, 0])];
    const r = build(colours, [
      { objects: 1, render: sym({ type: "area", fill: 0 }) },
      { objects: 2, render: sym({ type: "line", main: { colour: 0, widthUm: 300 } }) },
    ]);
    const mine = r.report.rows.filter((x) => x.source === 0);
    expect(mine.map((x) => [x.place, r.colours[x.row].id])).toEqual([["area", "src:1"], ["other", "src:1/none:other"]]);
    expect(r.report.split).toEqual([{ source: 0, sourceNumber: 1, roles: [null, null] }]);
  });

  it("aliases to the most used identified colour of the class, ties to the lowest index", () => {
    const colours = [colour(1, "Blå A", ink("blue100-line")), colour(2, "Blå B", ink("blue100-line"))];
    const tie = build(colours, [], ["blue100-area"]);
    expect(tie.report.aliased).toEqual([{ paletteId: "blue100-area", viaPaletteId: "blue100-line", sourceNumber: 1 }]);
    const used = build(colours, [{ objects: 3, render: sym({ type: "line", main: { colour: 1, widthUm: 180 } }) }], ["blue100-area"]);
    expect(used.report.aliased).toEqual([{ paletteId: "blue100-area", viaPaletteId: "blue100-line", sourceNumber: 2 }]);
    expect(used.colours[rowOfRole(used, "blue100-area")]).toMatchObject({ id: "src:2", sourceNumber: 2, cmyk: colours[1].cmyk });
  });

  it("gives an inserted purple 50 % the palette's ink, not the course purple's", () => {
    const colours = [colour(1, "Violett", [0.1, 0.9, 0.1, 0]), colour(2, "Svart", [0, 0, 0, 1])];
    const r = build(colours, [{ objects: 1, render: sym({ type: "line", main: { colour: 1, widthUm: 100 } }) }], ["purple50"], "ISSprOM2019-2", "iof2024");
    expect(r.colours[rowOfRole(r, "purple50")].cmyk).toEqual(ink("purple50", "iof2024"));
    expect(r.colours[rowOfRole(r, "purple-upper")].cmyk).toEqual([0.1, 0.9, 0.1, 0]);
  });

  it("copies spot and overprint to every row of a split colour", () => {
    const colours = [{ ...colour(12, "Brun 50%", ink("brown50-paved")), spot: { name: "Brown", knockout: true }, overprint: true as const }];
    const r = build(colours, [
      { objects: 1, render: sym({ type: "area", fill: 0 }) },
      { objects: 1, render: sym({ type: "line", main: { colour: 0, widthUm: 400 } }) },
    ]);
    const rows = r.report.rows.filter((x) => x.source === 0).map((x) => r.colours[x.row]);
    expect(rows).toHaveLength(2);
    for (const c of rows) expect(c).toMatchObject({ spot: { name: "Brown", knockout: true }, overprint: true, sourceNumber: 12 });
  });

  it("names an inserted row the edition lacks by the 2024 edition", () => {
    const r = build(isomColours, isomSymbols);
    expect(r.colours[rowOfRole(r, "orange-skio")].id).toBe("iof2024:orange-skio");
    expect(r.colours[rowOfRole(r, "green-skio")].id).toBe("iof2022:green-skio");
  });
});
