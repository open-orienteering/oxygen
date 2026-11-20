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
import { alignColourStack, alignmentPalette, identifySourceColours, OVERLAY_STACK_IDS, paletteIndexOfStack } from "../colour-align.js";
import { buildColourLayers, type ColourLayersResult, type DeviationChoice, deviationKey, KEPT_BY_DEFAULT, type LayerSymbol, symbolColourUses } from "../colour-layers.js";
import { nackareservatet2023, toColours } from "./club-colour-tables.js";
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

function build(
  colours: DocumentColour[],
  symbols: Sym[],
  needed: string[] = [],
  spec: SpecId = "ISOM2017-2",
  edition: PaletteEdition = "iof2022",
  deviations?: Record<string, DeviationChoice>,
): ColourLayersResult {
  const infos = identifySourceColours(colours, spec, edition);
  const uses = symbolColourUses(symbols, symbols.map((s) => s.objects), infos, rolePalette(spec, edition));
  return buildColourLayers({ colours, infos, uses, needed: new Set(needed), spec, edition, ...(deviations ? { deviations } : {}) });
}

/** Each row as `role` (or `none:<place>`, `graphic`) @ source number (or `+` for an inserted row); a moved part's row with `^`. */
const describeRows = (r: ColourLayersResult) =>
  r.report.rows.map((row) => `${row.role ?? (row.place ? `none:${row.place}` : "graphic")}${row.ownOrder ? "^" : ""}@${row.source === null ? "+" : r.colours[row.row].sourceNumber}`);

const rowOfRole = (r: ColourLayersResult, role: string, source?: number) =>
  r.report.rows.find((row) => row.role === role && (source === undefined || row.source === source))!.row;

/** The rows symbol `i` draws its references in, in `renderColourPaths` order. */
const rowsOf = (r: ColourLayersResult, i: number) => r.reindex.symbols[i]!;

/** The row of the colour with id `id`. */
const rowOf = (r: ColourLayersResult, id: string) => r.colours.findIndex((c) => c.id === id);

/**
 * The stack `build(isomColours, isomSymbols, …)` gives, bottom first. The table draws its one black under everything,
 * so the paved area's dots and edge and the building's edge stay under their fills (§9.3 "Own order"); the roleless
 * white and the graphic red bar stand where the source has them, between the contour brown and the blue; the unused
 * purple at the bottom and "Logga yta" (unused, area by name) at the top of the source.
 */
const EXPECTED = [
  "none:other@10",
  "yellow100@13",
  "green60-area@+",
  "green100-area@+",
  "black-road-outline^@11",
  "black100^@11",
  "brown50-paved@12",
  "white-over-green-brown@16",
  "blue100-area@18",
  "black100^@11",
  "black50-building@14",
  "black-road-outline@11",
  "brown50-road@12",
  "white-skio@+",
  "purple-lower@+",
  "brown100-line@15",
  "none:area@16",
  "graphic@17",
  "blue100-line@18",
  "brown100-point@15",
  "none:area@19",
  "black100@11",
  "orange-skio@+",
  "green-skio@+",
  "purple-upper@+",
];

/** Every symbol drawn from source keeps its parts' source order: a colour above another in the table draws above it. */
function expectOwnOrder(r: ColourLayersResult, colours: readonly DocumentColour[], symbols: readonly Sym[]) {
  symbols.forEach((s, i) => {
    if (!s.render || (s.match && (s.match.state === "auto" || s.match.reviewed))) return;
    const refs = renderColourPaths(s.render).map((x) => x.colour);
    const rows = rowsOf(r, i);
    refs.forEach((a, k) => refs.forEach((b, m) => {
      if (a < b) expect(rows[k], `symbol ${i}: colour ${colours[a].name} under ${colours[b].name}`).toBeLessThan(rows[m]);
    }));
  });
}

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
    const [left, , infill] = rowsOf(r, 1);
    expect(rowOfRole(r, "brown50-paved")).toBeLessThan(rowOfRole(r, "black50-building"));
    expect(rowOfRole(r, "black50-building")).toBeLessThan(left);
    expect(left).toBeLessThan(infill);
    expect(r.report.rows[infill].role).toBe("brown50-road");
  });

  it("keeps the colours of a split colour on their own rows: one black as road outline and, under fills it is drawn under, dots and edges", () => {
    // The last black100 is the zero-object row carrying the id §9.1 identified the black as (row I5: every black100 use moved).
    expect(r.report.split).toContainEqual({ source: 1, sourceNumber: 11, roles: ["black-road-outline", "black100", "black100", "black-road-outline", "black100"] });
    expect(r.report.rows.filter((x) => x.origin === "identified").map((x) => [x.role, x.source, x.objects])).toEqual([["white-over-green-brown", 6, 0], ["black100", 1, 0]]);
    const identified = r.report.rows.find((x) => x.origin === "identified" && x.role === "black100")!.row;
    expect(r.colours[identified]).toMatchObject({ id: "src:11/black100", paletteIds: ["black100"] });
    const [, dots, edge] = rowsOf(r, 0);
    expect(r.colours[edge].id).toBe("src:11");
    expect(r.colours[dots].id).toBe("src:11/black100/under1");
    expect(r.colours[rowsOf(r, 2)[1]].id).toBe("src:11/black100/under2");
    expect(r.colours[rowsOf(r, 1)[0]].id).toBe("src:11/black-road-outline");
    expect(new Set(r.colours.map((c) => c.id)).size).toBe(r.colours.length);
  });

  it("keeps every source-drawn symbol's parts in their source order", () => {
    expectOwnOrder(r, isomColours, isomSymbols);
    expect(r.report.rows.filter((x) => x.ownOrder).map((x) => x.role)).toEqual(["black-road-outline", "black100", "black100"]);
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

  it("places uses with no role, graphic objects' colours and unused roleless colours by the source order", () => {
    const white = r.report.rows.find((x) => x.source === 6 && x.origin === "use")!;
    expect(white).toMatchObject({ role: null, place: "area", objects: 1, sourceOrdered: "no-role" });
    // Between the layers its source neighbours stand on: over the contour brown (index 5), under the blue (index 8).
    expect(white.row).toBe(rowOfRole(r, "brown100-line") + 1);
    const red = r.report.rows.find((x) => x.source === 7)!;
    expect(red).toMatchObject({ role: null, place: null, objects: 2, graphicObjects: 2, sourceOrdered: "graphic" });
    expect(red.row).toBe(white.row + 1);
    expect(red.row + 1).toBe(rowOfRole(r, "blue100-line"));
    expect(r.colours[red.row].id).toBe("src:17");
    expect(r.report.noRole).toEqual([{ row: white.row, source: 6, sourceNumber: 16, place: "area", objects: 1 }]);
    expect(r.report.sourceOrdered.map((s) => [s.source, s.reason, s.aboveLowerPurple])).toEqual([
      [0, "no-role", false],
      [6, "no-role", true],
      [7, "graphic", true],
      [9, "no-role", true],
    ]);
    expect(rowOfRole(r, "white-skio") + 1).toBe(rowOfRole(r, "purple-lower"));
    expect(rowOfRole(r, "purple-upper")).toBe(r.colours.length - 1);
  });

  it("inserts both course purples in the map's purple ink; the source purple stays an ordinary colour", () => {
    const lower = r.colours[rowOfRole(r, "purple-lower")];
    const upper = r.colours[rowOfRole(r, "purple-upper")];
    expect(lower).toMatchObject({ id: "iof2022:purple-lower", cmyk: [0.35, 0.85, 0, 0], purpleRole: "lower", paletteIds: ["purple-lower"] });
    expect(upper).toMatchObject({ id: "iof2022:purple-upper", cmyk: [0.35, 0.85, 0, 0], purpleRole: "upper", paletteIds: ["purple-upper"] });
    expect(r.report.purpleInk).toBe(0);
    expect(r.colours.filter((c) => c.purpleRole)).toHaveLength(2);
    // The unused "Violett" is kept once with no role (a course purple candidate stands for no id), at the bottom where the source has it.
    expect(r.report.rows.find((x) => x.source === 0)).toMatchObject({ row: 0, role: null, place: "other", origin: "unreferenced", sourceOrdered: "no-role" });
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

  it("re-indexes per reference: the paved area's black is a road outline at its border and black 100 % in its dots, both under its fill", () => {
    const paved = reindexRenderColours(isomSymbols[0].render!, r.reindex.symbols[0]!);
    const pavedRow = rowOfRole(r, "brown50-paved");
    expect(renderColourPaths(paved).map((x) => r.report.rows[x.colour].role)).toEqual(["brown50-paved", "black100", "black-road-outline"]);
    expect(renderColourPaths(paved).map((x) => x.colour)).toEqual([pavedRow, pavedRow - 1, pavedRow - 2]);
    const road = reindexRenderColours(isomSymbols[1].render!, r.reindex.symbols[1]!);
    const outline = rowOf(r, "src:11/black-road-outline");
    expect(renderColourPaths(road).map((x) => x.colour)).toEqual([outline, outline, rowOfRole(r, "brown50-road")]);
  });

  it("maps every reference to a row of its own source colour, and each colour to its lowest row", () => {
    isomSymbols.forEach((s, i) => {
      if (!s.render) return expect(r.reindex.symbols[i]).toBeNull();
      const refs = renderColourPaths(s.render);
      r.reindex.symbols[i]!.forEach((row, k) => expect(r.report.rows[row].source).toBe(refs[k].colour));
    });
    isomColours.forEach((_, c) => {
      const mine = r.report.rows.filter((x) => x.source === c && x.origin !== "identified").map((x) => x.row);
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

  it("gives an inserted purple 50 % the course purples' ink, as §9.2 does (row I5, carried from I3)", () => {
    const colours = [colour(1, "Violett", [0.1, 0.9, 0.1, 0]), colour(2, "Svart", [0, 0, 0, 1])];
    const r = build(colours, [{ objects: 1, render: sym({ type: "line", main: { colour: 1, widthUm: 100 } }) }], ["purple50"], "ISSprOM2019-2", "iof2024");
    expect(r.colours[rowOfRole(r, "purple50")].cmyk).toEqual([0.1, 0.9, 0.1, 0]);
    expect(r.colours[rowOfRole(r, "purple-upper")].cmyk).toEqual([0.1, 0.9, 0.1, 0]);
    expect(r.colours[rowOfRole(r, "purple50")].purpleRole).toBe("upper");
    // With no purple in the map, the palette's.
    const none = build([colour(2, "Svart", [0, 0, 0, 1])], [], ["purple50"], "ISSprOM2019-2", "iof2024");
    expect(none.colours[rowOfRole(none, "purple50")].cmyk).toEqual(ink("purple50", "iof2024"));
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

// ---- Row I4: own order, deviations, source order -----------------------------------------------------------------

/** A line drawn as OCAD draws a road: a brown 50 % main as wide as the black side borders' centres, the borders over it. */
const ocadRoad = (main: number, border: number, objects: number, match: Sym["match"]): Sym => ({
  objects,
  match,
  render: sym({ type: "line", main: { colour: main, widthUm: 500 }, borders: { left: { colour: border, widthUm: 140, shiftUm: 250 }, right: { colour: border, widthUm: 140, shiftUm: 250 } } }),
});
const line = (c: number, objects: number, extra: Partial<Sym> = {}): Sym => ({ objects, render: sym({ type: "line", main: { colour: c, widthUm: 140 } }), ...extra });
const area = (c: number, objects: number, extra: Partial<Sym> = {}): Sym => ({ objects, render: sym({ type: "area", fill: c }), ...extra });
const suggested = (canonicalId: string) => ({ canonicalId, state: "suggested" as const, reviewed: false });
const auto = (canonicalId: string) => ({ canonicalId, state: "auto" as const, reviewed: false });

describe("buildColourLayers: own order against other symbols, and pass 2", () => {
  it("moves a part under its own over-part only: another colour's outline the source draws under it stays under it, and no pair of one role is a deviation", () => {
    // Black A, brown 50 %, black B: a cased road (outline A under its infill) and an inside-out road (brown main, borders B).
    const colours = [colour(1, "Svart A", [0, 0, 0, 1]), colour(2, "Brun 50%", ink("brown50-paved")), colour(3, "Svart B", [0, 0, 0, 1])];
    const cased: Sym = { objects: 5, match: suggested("ISOM2017-2:502"), render: sym({ type: "line", borders: { left: { colour: 0, widthUm: 140, shiftUm: 290 }, right: { colour: 0, widthUm: 140, shiftUm: 290 }, backgroundColour: 1 } }) };
    const symbols = [cased, ocadRoad(1, 2, 6, suggested("ISOM2017-2:502"))];
    const r = build(colours, symbols);
    const [main, borderB] = rowsOf(r, 1);
    const [outlineA, , infill] = rowsOf(r, 0);
    expect(outlineA).toBeLessThan(main); // the source draws the brown over black A, and so does the palette
    expect(main).toBeLessThan(borderB);
    expect(outlineA).toBeLessThan(infill);
    expectOwnOrder(r, colours, symbols);
    expect(r.report.deviations.filter((d) => d.upper === d.lower)).toEqual([]);
    expect(r.report.deviations.map((d) => deviationKey(d.upper, d.lower))).not.toContain("brown50-road>black-road-outline");
  });

  it("moves a roleless part the source order put over a part drawn over it to a row directly under that part (pass 2)", () => {
    // Ski green (a role over black 100 %), red (no role), black. The red goes over the ski green by the source order, so
    // over the black; a point drawing a red disc under a black one keeps its red under the black.
    const colours = [colour(1, "Grön skidspår", [0.91, 0, 0.83, 0]), colour(2, "Röd", [0, 1, 1, 0]), colour(3, "Svart", [0, 0, 0, 1])];
    const point: Sym = { objects: 1, render: sym({ type: "point", glyph: { parts: [disc(1), disc(2)], rotatable: false } }) };
    const symbols = [line(0, 10), line(1, 3), line(2, 1), point];
    const r = build(colours, symbols);
    const red = rowsOf(r, 1)[0];
    expect(red).toBeGreaterThan(rowOfRole(r, "black100"));
    const [redPart, blackPart] = rowsOf(r, 3);
    expect(r.report.rows[redPart]).toMatchObject({ source: 1, role: null, ownOrder: true, sourceOrdered: "no-role" });
    expect(redPart).toBe(blackPart - 1);
    // the moved part is the colour's lowest row, so it keeps the id; the row the gap gave is the split
    expect(r.colours[redPart].id).toBe("src:2");
    expect(r.colours[red].id).toBe("src:2/none:other");
    expectOwnOrder(r, colours, symbols);
  });
});

describe("buildColourLayers: own order (a symbol drawn inside out)", () => {
  // Contour brown, the road's brown 50 %, the black: the table draws the black over the brown 50 %.
  const colours = [colour(1, "Brun", ink("brown100-line")), colour(2, "Brun 50%", ink("brown50-paved")), colour(3, "Svart", [0, 0, 0, 1])];
  const symbols = [line(0, 20), ocadRoad(1, 2, 6, suggested("ISOM2017-2:502")), ocadRoad(1, 2, 4, auto("ISOM2017-2:502"))];
  const r = build(colours, symbols);

  it("keeps a source-drawn road's brown main under its black borders: the main goes to a row of its own under the road outline", () => {
    const [main, left, right] = rowsOf(r, 1);
    expect(r.report.rows[left]).toMatchObject({ role: "black-road-outline", ownOrder: false });
    expect(right).toBe(left);
    expect(r.report.rows[main]).toMatchObject({ role: "brown50-road", ownOrder: true, source: 1 });
    expect(main).toBe(left - 1);
    expect(r.colours[main].paletteIds).toBeUndefined();
    expectOwnOrder(r, colours, symbols);
  });

  it("leaves a library-drawn symbol's parts at their palette places, and the palette id on that row", () => {
    const [main, left] = rowsOf(r, 2);
    expect(r.report.rows[main]).toMatchObject({ role: "brown50-road", ownOrder: false });
    expect(main).toBeGreaterThan(left);
    expect(r.colours[main].paletteIds).toEqual(["brown50-road"]);
  });

  it("counts the inside-out symbol in no deviation; the library-drawn road's infill under the table's black is one, dropped", () => {
    // Upper: the outline row (the source-drawn road's 6 objects and the library road's 4); lower: the infill row, where
    // only the library road draws — the source-drawn road's main moved under the outline.
    expect(r.report.deviations.find((d) => deviationKey(d.upper, d.lower) === "black-road-outline>brown50-road")).toEqual({
      upper: "black-road-outline",
      lower: "brown50-road",
      kept: false,
      byDefault: true,
      objects: { upper: 10, lower: 4 },
    });
  });
});

/** Club-full's colour table (club-colour-tables.ts), its colours found by source number. */
const nacka = toColours(nackareservatet2023);
const nk = (n: number) => nacka.findIndex((c) => c.sourceNumber === n);

describe("buildColourLayers: deviations (Club-full's table: streets over the contours)", () => {
  const street: Sym = { objects: 10, render: sym({ type: "line", borders: { left: { colour: nk(101), widthUm: 140, shiftUm: 290 }, right: { colour: nk(101), widthUm: 140, shiftUm: 290 }, backgroundColour: nk(99) } }) };
  const symbols: Sym[] = [
    line(nk(107), 30), // 0: contour
    street, // 1: street outline and infill, both over the contour brown in the table
    area(nk(111), 8), // 2: paved area, under the contour brown
    area(nk(108), 5), // 3: lake, under the contour brown
    line(nk(468), 20), // 4: black 100 %
    area(nk(106), 2), // 5: a lake drawn in the line blue, over the contour brown
  ];
  const contour = (r: ColourLayersResult) => rowsOf(r, 0)[0];
  const [outline, , infill] = [0, 1, 2];

  it("lists every deviation with its object counts, the most objects first", () => {
    const r = build(nacka, symbols);
    const keys = r.report.deviations.map((d) => deviationKey(d.upper, d.lower));
    expect(keys).toEqual(expect.arrayContaining(["brown50-road>brown100-line", "black-road-outline>brown100-line", "blue100-area>brown100-line"]));
    expect(r.report.deviations.find((d) => d.upper === "brown50-road")).toEqual({ upper: "brown50-road", lower: "brown100-line", kept: true, byDefault: true, objects: { upper: 10, lower: 30 } });
    const totals = r.report.deviations.map((d) => d.objects.upper + d.objects.lower);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it("keeps streets over the contours by default: the contour brown sinks under the road, never under the lakes and paved areas it was drawn over", () => {
    const r = build(nacka, symbols);
    const road = rowsOf(r, 1);
    expect(contour(r)).toBeLessThan(road[outline]);
    expect(contour(r)).toBeLessThan(road[infill]);
    expect(contour(r)).toBeGreaterThan(rowsOf(r, 3)[0]);
    expect(contour(r)).toBeGreaterThan(rowsOf(r, 2)[0]);
    // On ISOM the contours then stand under lower purple; the road infill never goes above it.
    expect(road[infill]).toBeLessThan(rowOfRole(r, "purple-lower"));
    expect(contour(r)).toBeLessThan(rowOfRole(r, "purple-lower"));
    expect(r.report.deviations.find((d) => d.upper === "black-road-outline" && d.lower === "brown100-line")).toMatchObject({ kept: true, byDefault: true });
    expect([...KEPT_BY_DEFAULT]).toContain("brown50-paved>brown100-line");
  });

  it("drops a default deviation by override: the palette's order, the contour brown over the road and over lower purple", () => {
    const r = build(nacka, symbols, [], "ISOM2017-2", "iof2022", { "brown50-road>brown100-line": "drop", "black-road-outline>brown100-line": "drop" });
    const road = rowsOf(r, 1);
    expect(contour(r)).toBeGreaterThan(road[infill]);
    expect(contour(r)).toBeGreaterThan(road[outline]);
    expect(contour(r)).toBeGreaterThan(rowOfRole(r, "purple-lower"));
    expect(r.report.deviations.find((d) => d.upper === "brown50-road")).toMatchObject({ kept: false, byDefault: false });
  });

  it("drops any other deviation by default and keeps it by override (a lake the table draws over the contours)", () => {
    const byDefault = build(nacka, symbols);
    expect(rowsOf(byDefault, 5)[0]).toBeLessThan(contour(byDefault));
    expect(byDefault.report.deviations.find((d) => d.upper === "blue100-area")).toMatchObject({ lower: "brown100-line", kept: false, byDefault: true, objects: { upper: 2, lower: 30 } });
    const kept = build(nacka, symbols, [], "ISOM2017-2", "iof2022", { "blue100-area>brown100-line": "keep" });
    expect(rowsOf(kept, 5)[0]).toBeGreaterThan(contour(kept));
    expect(rowsOf(kept, 5)[0]).toBeLessThan(rowOfRole(kept, "purple-lower"));
    expect(kept.report.deviations.find((d) => d.upper === "blue100-area")).toMatchObject({ kept: true, byDefault: false });
  });
});

describe("buildColourLayers: deviations (roads over water, stones under open land)", () => {
  // Lake, contour brown, stream blue, road brown 50 %, road black — the table draws the road over the stream and the contours.
  const colours = [colour(1, "Blå yta", ink("blue100-area")), colour(2, "Brun", ink("brown100-line")), colour(3, "Blå", ink("blue100-line")), colour(4, "Brun 50%", ink("brown50-road")), colour(5, "Svart", [0, 0, 0, 1])];
  const road: Sym = { objects: 6, render: sym({ type: "line", borders: { left: { colour: 4, widthUm: 140, shiftUm: 290 }, right: { colour: 4, widthUm: 140, shiftUm: 290 }, backgroundColour: 3 } }) };
  const symbols: Sym[] = [area(0, 3), line(1, 12), line(2, 5), road];
  const stream = (r: ColourLayersResult) => rowsOf(r, 2)[0];
  const [outline, , infill] = [0, 1, 2];

  it("keeps roads over the blue line symbols by default: the stream sinks under the road, over the lake it was drawn over", () => {
    const r = build(colours, symbols);
    expect(stream(r)).toBeLessThan(rowsOf(r, 3)[outline]);
    expect(stream(r)).toBeLessThan(rowsOf(r, 3)[infill]);
    expect(stream(r)).toBeGreaterThan(rowsOf(r, 0)[0]);
    for (const upper of ["brown50-road", "black-road-outline"]) {
      expect(r.report.deviations.find((d) => d.upper === upper && d.lower === "blue100-line")).toMatchObject({ kept: true, byDefault: true, objects: { upper: 6, lower: 5 } });
    }
    // On ISOM the stream then stands under lower purple, as a kept road-over-contour deviation puts the contours.
    expect(stream(r)).toBeLessThan(rowOfRole(r, "purple-lower"));
  });

  it("keeps a bordered paved area whole over a stream: fill and edge both over it, never the edge alone", () => {
    const c = [colour(1, "Blå", ink("blue100-line")), colour(2, "Brun 50%", ink("brown50-paved")), colour(3, "Svart", [0, 0, 0, 1])];
    const paved: Sym = { objects: 3, render: sym({ type: "area", fill: 1, border: { main: { colour: 2, widthUm: 100 } } }) };
    const r = build(c, [line(0, 5), paved, line(2, 7)]);
    const [fill, edge] = rowsOf(r, 1);
    expect(rowsOf(r, 0)[0]).toBeLessThan(fill);
    expect(rowsOf(r, 0)[0]).toBeLessThan(edge);
    expect(r.report.deviations.find((d) => d.upper === "brown50-paved" && d.lower === "blue100-line")).toMatchObject({ kept: true, byDefault: true });
  });

  it("keeps the stream under the road and the contour over both when the table draws them so", () => {
    const c = [colour(1, "Blå", ink("blue100-line")), colour(2, "Brun 50%", ink("brown50-road")), colour(3, "Svart", [0, 0, 0, 1]), colour(4, "Brun", ink("brown100-line"))];
    const rd: Sym = { objects: 6, render: sym({ type: "line", borders: { left: { colour: 2, widthUm: 140, shiftUm: 290 }, right: { colour: 2, widthUm: 140, shiftUm: 290 }, backgroundColour: 1 } }) };
    const r = build(c, [line(0, 5), rd, line(3, 12)]);
    expect(rowsOf(r, 0)[0]).toBeLessThan(rowsOf(r, 1)[infill]);
    expect(rowsOf(r, 2)[0]).toBeGreaterThan(rowsOf(r, 1)[outline]);
    expect(r.report.deviations.every((d) => !d.blockedBy)).toBe(true);
  });

  it("draws the stream over the road again when both are dropped by override", () => {
    const r = build(colours, symbols, [], "ISOM2017-2", "iof2022", { "brown50-road>blue100-line": "drop", "black-road-outline>blue100-line": "drop" });
    expect(stream(r)).toBeGreaterThan(rowsOf(r, 3)[outline]);
    expect(stream(r)).toBeGreaterThan(rowsOf(r, 3)[infill]);
  });

  it("keeps roads over the stream on ISSprOM too (blue100-pointline)", () => {
    const spr = [colour(1, "Blå", ink("blue100-pointline")), colour(2, "Brun 50%", ink("brown50-road")), colour(3, "Svart", [0, 0, 0, 1])];
    const sprRoad: Sym = { objects: 4, render: sym({ type: "line", borders: { left: { colour: 2, widthUm: 140, shiftUm: 290 }, right: { colour: 2, widthUm: 140, shiftUm: 290 }, backgroundColour: 1 } }) };
    const r = build(spr, [line(0, 5), sprRoad], [], "ISSprOM2019-2");
    expect(rowsOf(r, 0)[0]).toBeLessThan(rowsOf(r, 1)[2]);
    expect(rowsOf(r, 0)[0]).toBeLessThan(rowsOf(r, 1)[0]);
    for (const upper of ["brown50-road", "black-road-outline"]) {
      expect(r.report.deviations.find((d) => d.upper === upper && d.lower === "blue100-pointline")).toMatchObject({ kept: true, byDefault: true });
    }
  });

  it("draws stones over open land when the table hides them under it: dropped by default, kept by override", () => {
    // Black for boulders under the yellow, as on an older club map: in the map's order the open land covers the stones.
    const two = [colour(1, "Svart", [0, 0, 0, 1]), colour(2, "Gul", ink("yellow100"))];
    const stones: Sym = { objects: 9, render: sym({ type: "point", glyph: { parts: [disc(0)], rotatable: false } }) };
    const byDefault = build(two, [stones, area(1, 4)]);
    expect(rowsOf(byDefault, 0)[0]).toBeGreaterThan(rowsOf(byDefault, 1)[0]);
    expect(byDefault.report.deviations.find((d) => d.upper === "yellow100")).toMatchObject({ lower: "black100", kept: false, byDefault: true, objects: { upper: 4, lower: 9 } });
    const kept = build(two, [stones, area(1, 4)], [], "ISOM2017-2", "iof2022", { "yellow100>black100": "keep" });
    expect(rowsOf(kept, 0)[0]).toBeLessThan(rowsOf(kept, 1)[0]);
  });
});

describe("buildColourLayers: kept deviations that cannot all hold", () => {
  // Lake, contour brown, paved brown — the table draws the paved brown over both.
  const colours = [colour(1, "Blå", ink("blue100-area")), colour(2, "Brun", ink("brown100-line")), colour(3, "Brun 50%", ink("brown50-paved"))];
  const symbols = [area(0, 4), line(1, 9), area(2, 3)];

  it("keeps a deviation dropped by default when a kept one needs it, and says which", () => {
    const r = build(colours, symbols);
    // Paved over contour is kept; lake under contour holds both ways; so paved over lake must hold too.
    expect(rowsOf(r, 0)[0]).toBeLessThan(rowsOf(r, 1)[0]);
    expect(rowsOf(r, 1)[0]).toBeLessThan(rowsOf(r, 2)[0]);
    expect(r.report.deviations.find((d) => d.upper === "brown50-paved" && d.lower === "blue100-area")).toEqual({
      upper: "brown50-paved",
      lower: "blue100-area",
      kept: true,
      byDefault: true,
      objects: { upper: 3, lower: 4 },
      impliedBy: ["brown50-paved>brown100-line"],
    });
    expect(rowsOf(r, 2)[0]).toBeLessThan(rowOfRole(r, "purple-lower"));
  });

  it("drops a kept deviation that contradicts an explicit drop, and says what blocked it", () => {
    const r = build(colours, symbols, [], "ISOM2017-2", "iof2022", { "brown50-paved>blue100-area": "drop" });
    expect(rowsOf(r, 2)[0]).toBeLessThan(rowsOf(r, 0)[0]);
    expect(rowsOf(r, 0)[0]).toBeLessThan(rowsOf(r, 1)[0]);
    expect(r.report.deviations.find((d) => d.lower === "brown100-line")).toEqual({
      upper: "brown50-paved",
      lower: "brown100-line",
      kept: false,
      byDefault: true,
      objects: { upper: 3, lower: 9 },
      blockedBy: ["blue100-area"],
    });
  });

  it("leaves nothing implied by a deviation that is then blocked", () => {
    // Building, lake, contour, paved brown on top; the paved brown over the building dropped by override.
    const four = [colour(1, "Svart 50%", ink("black50-building")), ...colours.map((c) => ({ ...c, sourceNumber: c.sourceNumber! + 1, id: `src:${c.sourceNumber! + 1}` }))];
    const r = build(four, [area(0, 2), area(1, 4), line(2, 9), area(3, 3)], [], "ISOM2017-2", "iof2022", { "brown50-paved>black50-building": "drop" });
    const dev = (u: string, l: string) => r.report.deviations.find((d) => d.upper === u && d.lower === l);
    expect(dev("brown50-paved", "brown100-line")).toMatchObject({ kept: false, blockedBy: expect.any(Array) });
    expect(dev("brown50-paved", "blue100-area")).toMatchObject({ kept: false, byDefault: true });
    expect(dev("brown50-paved", "blue100-area")!.impliedBy).toBeUndefined();
    for (const d of r.report.deviations) if (d.impliedBy) expect(d.impliedBy.every((k) => r.report.deviations.some((x) => deviationKey(x.upper, x.lower) === k && x.kept))).toBe(true);
  });

  it("resolves the same way every time", () => {
    const a = build(colours, symbols, [], "ISOM2017-2", "iof2022", { "brown50-paved>blue100-area": "drop" });
    const b = build(colours.map((c) => ({ ...c })), symbols.map((s) => ({ ...s })), [], "ISOM2017-2", "iof2022", { "brown50-paved>blue100-area": "drop" });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("buildColourLayers: source order (masks, graphic objects, no role)", () => {
  // Yellow, its white, black, contour brown, then a white the mapper draws over everything to blank out a control description box.
  const colours = [colour(1, "Gul", ink("yellow100")), colour(2, "Vit för gul", [0, 0, 0, 0]), colour(3, "Svart", [0, 0, 0, 1]), colour(4, "Brun", ink("brown100-line")), colour(5, "Vit mask", [0, 0, 0, 0])];
  const symbols: Sym[] = [
    area(0, 6), // 0: open land
    area(1, 2, { match: suggested("ISOM2017-2:402") }), // 1: the white of semi-open land, by hint white-over-yellow
    line(2, 12), // 2: black 100 %
    line(3, 9), // 3: contour
    area(4, 1, { match: suggested("ISOM2017-2:405") }), // 4: the mask, by hint white-over-green-brown
    line(2, 3, { origin: "graphic" }), // 5: a black frame bar of a graphic object
  ];
  const r = build(colours, symbols);

  it("places a white the source draws over layers the palette ranks above its role by the source order: a mask", () => {
    const mask = r.report.rows[rowsOf(r, 4)[0]];
    expect(mask).toMatchObject({ role: "white-over-green-brown", sourceOrdered: "mask" });
    expect(mask.row).toBeGreaterThan(rowOfRole(r, "black100"));
    expect(mask.row).toBeLessThan(rowOfRole(r, "purple-upper"));
    expect(r.colours[mask.row].paletteIds).toBeUndefined();
    expect(r.report.sourceOrdered).toContainEqual({ row: mask.row, source: 4, sourceNumber: 5, reason: "mask", role: "white-over-green-brown", objects: 1, aboveLowerPurple: true });
  });

  it("leaves a white the source draws where the palette has it at its palette place", () => {
    expect(r.report.rows[rowsOf(r, 1)[0]]).toMatchObject({ role: "white-over-yellow", sourceOrdered: null });
    expect(rowsOf(r, 1)[0]).toBe(rowsOf(r, 0)[0] + 1);
  });

  it("puts a graphic object's colour on a row of its own at the source's place: the frame bar over the yellow and white, under the contour brown", () => {
    const bar = rowsOf(r, 5)[0];
    expect(r.report.rows[bar]).toMatchObject({ source: 2, role: null, place: null, sourceOrdered: "graphic", objects: 3, graphicObjects: 3 });
    // The black's lowest row keeps its id; its black 100 % row is the split.
    expect(r.colours[bar].id).toBe("src:3");
    expect(r.colours[rowOfRole(r, "black100")].id).toBe("src:3/black100");
    expect(bar).toBeGreaterThan(rowsOf(r, 1)[0]);
    expect(bar).toBeLessThan(rowsOf(r, 3)[0]);
  });

  it("keeps an inserted white-upper over the roleless colours the source has on top (ISSprOM)", () => {
    const sprint = [colour(1, "Svart", [0, 0, 0, 1]), colour(2, "Röd", [0, 1, 1, 0])];
    const s = build(sprint, [line(0, 5), line(1, 2)], ["white-upper"], "ISSprOM2019-2", "iof2024");
    const red = rowsOf(s, 1)[0];
    expect(s.report.rows[red]).toMatchObject({ role: null, sourceOrdered: "no-role" });
    expect(red).toBeGreaterThan(rowOfRole(s, "black100"));
    expect(red).toBeLessThan(rowOfRole(s, "white-upper"));
  });
});

describe("buildColourLayers: which row carries a palette id", () => {
  it("is the row of the colour §9.2 step 2 takes for the id (the most used colour), not the row with the most objects", () => {
    const colours = [colour(1, "Gul", ink("yellow100")), colour(2, "Svart A", [0, 0, 0, 1]), colour(3, "Svart B", [0, 0, 0, 1])];
    const cultivated: Sym = { objects: 10, render: sym({ type: "area", fill: 0, patterns: [{ glyph: { parts: [disc(1)], rotatable: false }, cellWidthUm: 500, cellHeightUm: 500 }] }) };
    const r = build(colours, [cultivated, line(1, 1), line(2, 5)]);
    const a = rowsOf(r, 1)[0], b = rowsOf(r, 2)[0];
    expect([r.report.rows[a].role, r.report.rows[b].role]).toEqual(["black100", "black100"]);
    expect(r.colours[a].paletteIds).toEqual(["black100"]);
    expect(r.colours[b].paletteIds).toBeUndefined();
  });
});

// ---- Row I5: what the importer needs of the stack ---------------------------------------------------------------

describe("buildColourLayers: every palette id §9.2 identifies is carried (row I5)", () => {
  it("carries an identified id whose colour draws only in another role, on a zero-object row of that colour at the palette place", () => {
    const colours = [colour(1, "Blå", ink("blue100-line")), colour(2, "Svart", [0, 0, 0, 1])];
    const r = build(colours, [area(0, 4), line(1, 2)]);
    const at = r.colours.findIndex((c) => c.paletteIds?.includes("blue100-line"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(r.report.rows[at]).toMatchObject({ source: 0, role: "blue100-line", objects: 0, sourceOrdered: null, ownOrder: false });
    expect(r.colours[at]).toMatchObject({ sourceNumber: 1, cmyk: colours[0].cmyk });
    expect(r.colours[rowOfRole(r, "blue100-area")].paletteIds).toEqual(["blue100-area"]);
  });

  it("has every palette id the source order has, on the badly ordered table and on Club-full's", () => {
    const cases: [DocumentColour[], Sym[]][] = [
      [isomColours, isomSymbols],
      [nacka, [line(nk(107), 30), area(nk(111), 8), area(nk(108), 5), line(nk(468), 20), area(nk(106), 2)]],
    ];
    for (const [colours, symbols] of cases) {
      const infos = identifySourceColours(colours, "ISOM2017-2", "iof2022");
      const usage = new Array<number>(colours.length).fill(0);
      symbols.forEach((s) => { if (s.render) for (const c of new Set(renderColourPaths(s.render).map((x) => x.colour))) usage[c] += s.objects; });
      const source = alignColourStack({ colours, infos, spec: "ISOM2017-2", edition: "iof2022", needed: new Set(), usage });
      const layered = build(colours, symbols);
      const ids = new Set(layered.colours.flatMap((c) => c.paletteIds ?? []));
      for (const id of source.colours.flatMap((c) => c.paletteIds ?? [])) expect(ids, id).toContain(id);
    }
  });
});

describe("buildColourLayers: a library-drawn symbol counts on its entry's palette ids (row I5, carried from I4)", () => {
  // ISOM 502 (a road) draws in black-road-outline and brown50-road. The source symbol here references only a brown 50 %
  // main: the library road still draws its outline on the black carrier.
  const colours = [colour(1, "Brun", ink("brown100-line")), colour(2, "Brun 50%", ink("brown50-paved")), colour(3, "Svart", [0, 0, 0, 1])];
  const libraryRoad: Sym = { objects: 6, match: auto("ISOM2017-2:502"), render: sym({ type: "line", main: { colour: 1, widthUm: 500 } }) };
  const symbols = [line(0, 20), libraryRoad, line(2, 3)];
  const needed = ["black-road-outline", "brown50-road"];
  const r = build(colours, symbols, needed);

  it("counts its objects on the rows carrying the entry's ids, not on its own references' rows", () => {
    const carrierOf = (id: string) => r.colours.findIndex((c) => c.paletteIds?.includes(id));
    expect(r.report.rows[carrierOf("brown50-road")].objects).toBe(6);
    expect(r.report.rows[carrierOf("black-road-outline")].objects).toBe(6);
    expect(r.report.rows[carrierOf("black100")].objects).toBe(3);
  });

  it("makes the outline carrier a used row in the deviations: the road outline the black is drawn over by the table", () => {
    // The table draws the contour brown under the black and the brown 50 %; the library road's outline counts on the black.
    const keys = r.report.deviations.map((d) => deviationKey(d.upper, d.lower));
    expect(keys).toContain("black-road-outline>brown100-line");
    expect(r.report.deviations.find((d) => d.upper === "black-road-outline")).toMatchObject({ kept: true, byDefault: true, objects: { upper: 6, lower: 20 } });
  });
});
