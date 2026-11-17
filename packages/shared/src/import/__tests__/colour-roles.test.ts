/**
 * Colour roles (docs/map-symbols.md §9.3 "Roles", row I2): every colour
 * reference of a symbol's render is a use with a part, and each use gets a
 * palette id of the alignment palette — from the matched or suggested
 * library entry, else the rule table, else none. Synthetic symbols shaped
 * like the corpus cases; no club map geometry.
 */

import { describe, expect, it } from "vitest";
import type { DocumentColour } from "../../map-document/header.js";
import { formatColourPath, renderColourRefs } from "../../render/transform.js";
import { parseRenderSymbol, type RenderSymbol } from "../../render/symbol.js";
import { getSymbolLibrary, listSymbolLibraries } from "../../symbol-library/index.js";
import { type PaletteEdition, paletteFor, paletteIndex, type SpecId } from "../../symbol-library/palette.js";
import { resolveEntry } from "../../symbol-library/schema.js";
import { identifySourceColours } from "../colour-align.js";
import { classifyCmyk } from "../colour-class.js";
import {
  type ColourPart, colourRoles, colourUses, type RoleColourInfo, roleFromMatch, roleFromRule, roleOfUse, rolePalette, type RoleSymbol,
} from "../colour-roles.js";

const disc = (colour: number) => ({ kind: "disc" as const, colour, diameterUm: 200 });
const stroke = (colour: number) => ({ kind: "stroke" as const, colour, widthUm: 140, geometry: { coords: [0, 0, 0, 400] } });

const sym = (input: Record<string, unknown>): RenderSymbol => parseRenderSymbol({ id: "s", code: "1", name: "s", ...input });

const parts = (render: RenderSymbol) => colourUses(render).map((u) => [formatColourPath(u.path), u.colour, u.part]);

describe("colourUses", () => {
  it("names the parts of an area: fill, hatch, pattern, border", () => {
    const render = sym({
      type: "area", fill: 1,
      hatches: [{ colour: 2, widthUm: 100, spacingUm: 400 }],
      patterns: [{ glyph: { parts: [disc(3)], rotatable: false }, cellWidthUm: 500, cellHeightUm: 500 }],
      border: { main: { colour: 3, widthUm: 100 }, borders: { left: { colour: 4, widthUm: 100, shiftUm: 50 } } },
    });
    expect(parts(render)).toEqual([
      ["fill", 1, "area-fill"],
      ["hatches[0].colour", 2, "area-hatch"],
      ["patterns[0].glyph.parts[0].colour", 3, "area-pattern"],
      ["border.main.colour", 3, "area-border"],
      ["border.borders.left.colour", 4, "area-border"],
    ]);
  });

  it("names the parts of a line: main, halo, outline pairs, infill, glyphs", () => {
    const render = sym({
      type: "line",
      main: { colour: 5, widthUm: 250, halo: { colour: 0, widthUm: 50 } },
      borders: {
        left: { colour: 0, widthUm: 140, shiftUm: 290 }, right: { colour: 0, widthUm: 140, shiftUm: 290 }, backgroundColour: 5,
        extraPairs: [{ left: { colour: 6, widthUm: 100, shiftUm: 500 } }],
      },
      glyphs: [{ glyph: { parts: [stroke(0)], rotatable: true }, placement: { at: "start" } }],
    });
    expect(parts(render)).toEqual([
      ["main.colour", 5, "line-main"],
      ["main.halo.colour", 0, "line-halo"],
      ["borders.left.colour", 0, "line-outline"],
      ["borders.right.colour", 0, "line-outline"],
      ["borders.backgroundColour", 5, "line-infill"],
      ["borders.extraPairs[0].left.colour", 6, "line-outline"],
      ["glyphs[0].glyph.parts[0].colour", 0, "line-glyph"],
    ]);
  });

  it("names a point's glyph parts and a text's colour, halo, shadow and frame", () => {
    expect(parts(sym({ type: "point", glyph: { parts: [disc(0), stroke(2)], rotatable: false } }))).toEqual([
      ["glyph.parts[0].colour", 0, "point-glyph"],
      ["glyph.parts[1].colour", 2, "point-glyph"],
    ]);
    const text = sym({
      type: "text", fontFamily: "liberation-sans", fontSizeUm: 2000, colour: 0,
      halo: { colour: 7, widthUm: 100 }, shadow: { colour: 2, offsetXUm: 10, offsetYUm: 10 }, frame: { colour: 8, leftUm: 0, bottomUm: 0, rightUm: 0, topUm: 0 },
    });
    expect(parts(text).map(([, , p]) => p)).toEqual(["text", "text-halo", "text-shadow", "text-frame"]);
  });
});

// ---- Roles -------------------------------------------------------------------

const ISOM: SpecId = "ISOM2017-2";
const SPR: SpecId = "ISSprOM2019-2";

const col = (n: number, name: string, c: number, m: number, y: number, k: number): DocumentColour =>
  ({ id: `src:${n}`, name, cmyk: [c / 100, m / 100, y / 100, k / 100], sourceNumber: n });

/**
 * A club-style table, source order (index 0 drawn first), shaped like the
 * corpus: one brown 50 % for paved areas and road infill, one black for
 * everything black, one grey, a mask white, a purple, ski colours.
 */
const table: DocumentColour[] = [
  col(1, "Gul", 0, 27, 79, 0),            // 0 yellow 100
  col(2, "Gul 50%", 0, 14, 40, 0),        // 1 yellow 50
  col(3, "Grön 30%", 24, 0, 30, 0),       // 2 green 30
  col(4, "Grön 60%", 48, 0, 60, 0),       // 3 green 60
  col(5, "Grön", 80, 0, 100, 0),          // 4 green 100
  col(6, "Mörkgrön", 100, 0, 80, 30),     // 5 dark green
  col(7, "Brun 50%", 10, 35, 50, 0),      // 6 brown 50 — paved area and road infill
  col(8, "Brun 30%", 6, 23, 33, 0),       // 7 brown 30
  col(9, "Grå", 0, 0, 0, 35),             // 8 black 35
  col(10, "Svart 50%", 0, 0, 0, 50),      // 9 black 50
  col(11, "Svart 20%", 0, 0, 0, 20),      // 10 black 20
  col(12, "Blå 50%", 50, 0, 0, 0),        // 11 blue 50
  col(13, "Blå 70%", 70, 0, 0, 0),        // 12 blue 70
  col(14, "Blå 30%", 30, 0, 0, 0),        // 13 blue 30
  col(15, "Blå", 100, 0, 0, 0),           // 14 blue 100
  col(16, "Brun", 25, 75, 100, 0),        // 15 brown 100
  col(17, "Oliv", 38, 27, 100, 0),        // 16 olive
  col(18, "Svart", 0, 0, 0, 100),         // 17 black 100
  col(19, "Vit", 0, 0, 0, 0),             // 18 white
  col(20, "Violett", 35, 85, 0, 0),       // 19 purple
  col(21, "Grön för skidspår", 91, 0, 83, 0), // 20 ski green (by name)
  col(22, "Orange", 0, 60, 100, 0),       // 21 ski orange (by position: above every black)
  col(23, "Vit under skidspår", 0, 0, 0, 0), // 22 ski mask white (by name)
];
const C = { yellow: 0, yellow50: 1, green30: 2, green60: 3, green: 4, dark: 5, brown50: 6, brown30: 7, grey35: 8, black50: 9, black20: 10, blue50: 11, blue70: 12, blue30: 13, blue: 14, brown: 15, olive: 16, black: 17, white: 18, purple: 19, skiGreen: 20, skiOrange: 21, skiWhite: 22 };
const infosFor = (spec: SpecId, edition: PaletteEdition = "iof2024"): RoleColourInfo[] => identifySourceColours(table, spec, edition);

type Match = RoleSymbol["match"];
const area = (input: Record<string, unknown>, match?: Match): RoleSymbol => ({ render: sym({ type: "area", ...input }), match });
const line = (input: Record<string, unknown>, match?: Match): RoleSymbol => ({ render: sym({ type: "line", ...input }), match });
const point = (colours: number[], match?: Match): RoleSymbol => ({ render: sym({ type: "point", glyph: { parts: colours.map(disc), rotatable: false } }), match });
const textSym = (colour: number, match?: Match): RoleSymbol => ({ render: sym({ type: "text", fontFamily: "liberation-sans", fontSizeUm: 2000, colour }), match });

const roles = (s: RoleSymbol, spec: SpecId = ISOM, edition: PaletteEdition = "iof2024") =>
  colourRoles(s, infosFor(spec, edition), rolePalette(spec, edition)).map((r) => [formatColourPath(r.path), r.role, r.via]);
const rolesOnly = (s: RoleSymbol, spec: SpecId = ISOM) => roles(s, spec).map(([, role]) => role);

const suggested = (canonicalId: string | null): Match => ({ canonicalId });
const dots = (colour: number) => [{ glyph: { parts: [disc(colour)], rotatable: false }, cellWidthUm: 600, cellHeightUm: 600 }];
const road = (infill: number, outline: number, glyph?: number) => ({
  borders: { left: { colour: outline, widthUm: 140, shiftUm: 290 }, right: { colour: outline, widthUm: 140, shiftUm: 290 }, backgroundColour: infill },
  ...(glyph !== undefined ? { glyphs: [{ glyph: { parts: [stroke(glyph)], rotatable: true }, placement: { at: "corners" } }] } : {}),
});

describe("roleOfUse: the rule table (no match)", () => {
  it("one brown 50 % as a paved area and as road infill takes two roles (ISOM)", () => {
    expect(roles(area({ fill: C.brown50, border: { main: { colour: C.black, widthUm: 100 } } }))).toEqual([
      ["fill", "brown50-paved", "rule"],
      ["border.main.colour", "black-road-outline", "rule"],
    ]);
    expect(roles(line(road(C.brown50, C.black)))).toEqual([
      ["borders.left.colour", "black-road-outline", "rule"],
      ["borders.right.colour", "black-road-outline", "rule"],
      ["borders.backgroundColour", "brown50-road", "rule"],
    ]);
  });

  it("ISSprOM splits brown screens by percent; ISOM has only the 50 % rows", () => {
    expect(rolesOnly(area({ fill: C.brown30 }), SPR)).toEqual(["brown30-paved"]);
    expect(rolesOnly(area({ fill: C.brown50 }), SPR)).toEqual(["brown50-paved"]);
    expect(rolesOnly(line({ main: { colour: C.brown30, widthUm: 350 } }), SPR)).toEqual(["brown30-road"]);
    expect(rolesOnly(line(road(C.brown30, C.black)), SPR)).toEqual(["black-road-outline", "black-road-outline", "brown30-road"]);
    expect(rolesOnly(area({ fill: C.brown30 }), ISOM)).toEqual(["brown50-paved"]);
  });

  it("one black as building outline, road outline, cultivated dots, stony-ground dots and a dash glyph", () => {
    // Large building: black 50 % with a black outline.
    expect(rolesOnly(area({ fill: C.black50, border: { main: { colour: C.black, widthUm: 200 } } }))).toEqual(["black50-building", "black100"]);
    // Cultivated land: yellow with black dots.
    expect(rolesOnly(area({ fill: C.yellow, patterns: dots(C.black) }))).toEqual(["yellow100", "black-cultivated"]);
    // Stony ground: black dots, no yellow fill (answer Q1).
    expect(rolesOnly(area({ patterns: dots(C.black) }))).toEqual(["black100"]);
    // A yellow area with a black hatch is no dot pattern.
    expect(rolesOnly(area({ fill: C.yellow, hatches: [{ colour: C.black, widthUm: 100, spacingUm: 500 }] }))).toEqual(["yellow100", "black100"]);
    // The same black twice in one road: outline and a tick glyph.
    expect(rolesOnly(line(road(C.brown50, C.black, C.black)))).toEqual(["black-road-outline", "black-road-outline", "brown50-road", "black100"]);
    // Mapper's combined road: brown main over a black halo.
    expect(rolesOnly(line({ main: { colour: C.brown50, widthUm: 300, halo: { colour: C.black, widthUm: 140 } } }))).toEqual(["brown50-road", "black-road-outline"]);
    // A railway: black infill band under white dashes — the black is black 100 %, the white has no rule.
    expect(rolesOnly(line({ main: { colour: C.white, widthUm: 250 }, borders: { backgroundColour: C.black, backgroundWidthUm: 450 } }))).toEqual([null, "black100"]);
  });

  it("black screens go by percent, whatever the part", () => {
    expect(rolesOnly(area({ fill: C.black50 }))).toEqual(["black50-building"]);
    expect(rolesOnly(area({ fill: C.grey35 }))).toEqual(["black-area-screen"]);
    expect(rolesOnly(area({ fill: C.black20 }))).toEqual(["black20-canopy"]);
    expect(rolesOnly(point([C.black50]))).toEqual(["black50-building"]);
    expect(rolesOnly(area({ fill: C.grey35 }), SPR)).toEqual(["black-area-screen"]);
  });

  it("blue, brown 100 %, green, dark green, yellow and olive by kind and part, per spec", () => {
    const cases: [RoleSymbol, (string | null)[], (string | null)[]][] = [
      [area({ fill: C.blue, border: { main: { colour: C.blue, widthUm: 100 } } }), ["blue100-area", "blue100-line"], ["blue100-area", "blue100-pointline"]],
      [area({ hatches: [{ colour: C.blue, widthUm: 100, spacingUm: 400 }] }), ["blue100-area"], ["blue100-area"]],
      [line({ main: { colour: C.blue, widthUm: 180 } }), ["blue100-line"], ["blue100-pointline"]],
      [point([C.blue]), ["blue100-point"], ["blue100-pointline"]],
      [area({ fill: C.blue70 }), ["blue70-area"], ["blue70-area"]],
      [area({ fill: C.blue50 }), ["blue50-area"], ["blue50-area"]],
      [area({ fill: C.blue30 }), ["blue50-area"], ["blue30-area"]],
      [line({ main: { colour: C.brown, widthUm: 140 } }), ["brown100-line"], ["brown100"]],
      [point([C.brown]), ["brown100-point"], ["brown100"]],
      [textSym(C.brown), ["brown100-line"], ["brown100"]],
      [area({ fill: C.green }), ["green100-area"], ["green100-area"]],
      [area({ fill: C.green60 }), ["green60-area"], ["green60-area"]],
      [area({ fill: C.green30 }), ["green30-area"], ["green30-area"]],
      [point([C.green]), ["green100-point"], ["green100-point"]],
      [line({ main: { colour: C.black, widthUm: 140, halo: { colour: C.green30, widthUm: 155, continuous: true } } }), ["black100", "green30-area"], ["black100", "green30-area"]],
      [area({ fill: C.dark }), [null], ["darkgreen-area"]],
      [line({ main: { colour: C.dark, widthUm: 300 } }), ["darkgreen-hedge"], ["darkgreen-line"]],
      [area({ fill: C.yellow }), ["yellow100"], ["yellow100"]],
      [area({ fill: C.yellow50 }), ["yellow50"], ["yellow50"]],
      [area({ fill: C.olive }), ["olive"], ["olive"]],
    ];
    for (const [s, isom, spr] of cases) {
      expect(rolesOnly(s, ISOM)).toEqual(isom);
      expect(rolesOnly(s, SPR)).toEqual(spr);
    }
  });

  it("whites and purples get no role without a hint; nor do unclassified colours", () => {
    expect(rolesOnly(area({ fill: C.white }))).toEqual([null]);
    expect(rolesOnly(point([C.purple]))).toEqual([null]);
    const odd: RoleColourInfo[] = [{ class: null }];
    const s = point([0]);
    expect(roleOfUse(colourUses(s.render)[0], odd, s, rolePalette(ISOM, "iof2024"))).toBeNull();
  });

  it("a colour §9.1 identifies as an ISSkiOM track colour keeps that role; the ski mask white does not (answer Q2)", () => {
    const track = line({ main: { colour: C.skiGreen, widthUm: 600, halo: { colour: C.skiWhite, widthUm: 150 } } });
    expect(rolesOnly(track)).toEqual(["green-skio", null]);
    expect(rolesOnly(line({ main: { colour: C.skiOrange, widthUm: 360 } }))).toEqual(["orange-skio"]);
    expect(rolesOnly(line({ main: { colour: C.skiOrange, widthUm: 360 } }), SPR)).toEqual(["orange-skio"]);
  });

  it("a spec without a table gives no rule role", () => {
    const s = area({ fill: C.yellow });
    const infos = identifySourceColours(table, "ISMTBOM2022", "iof2024");
    expect(roleFromRule(colourUses(s.render)[0], infos, s, rolePalette("ISMTBOM2022", "iof2024"))).toBeNull();
  });

  it("every rule role is a row of the spec's own palette, both editions", () => {
    const allParts: [RoleSymbol, ColourPart][] = [];
    for (let i = 0; i < table.length; i++) {
      allParts.push(
        [area({ fill: i }), "area-fill"],
        [area({ fill: C.yellow, patterns: dots(i) }), "area-pattern"],
        [area({ fill: C.brown50, border: { main: { colour: i, widthUm: 100 } } }), "area-border"],
        [line({ main: { colour: C.brown50, widthUm: 300, halo: { colour: i, widthUm: 100 } } }), "line-halo"],
        [line(road(i, i, i)), "line-outline"],
        [point([i]), "point-glyph"],
        [textSym(i), "text"],
      );
    }
    for (const spec of [ISOM, SPR]) {
      for (const edition of ["iof2024", "iof2022"] as const) {
        const own = new Set(paletteFor(edition, spec).map((p) => p.id));
        const infos = infosFor(spec, edition);
        const palette = rolePalette(spec, edition);
        for (const [s] of allParts) {
          for (const use of colourUses(s.render)) {
            const role = roleFromRule(use, infos, s, palette);
            if (role && !["green-skio", "orange-skio"].includes(role)) expect(own.has(role), `${spec} ${edition} ${role}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("roleOfUse: the hint (the matched or suggested library entry)", () => {
  it("reads canonicalId in any match state and beats the rule", () => {
    // A brown 30 % line: the rule says road infill; ISSprOM 532 (stairway) draws it as paved area.
    const stairs = (match: Match) => line({ main: { colour: C.brown30, widthUm: 400 } }, match);
    for (const state of ["auto", "suggested", "unmatched"] as const) {
      expect(roles(stairs({ canonicalId: "ISSprOM2019-2:532", state } as Match), SPR)).toEqual([["main.colour", "brown30-paved", "match"]]);
    }
    expect(roles(stairs(suggested(null)), SPR)).toEqual([["main.colour", "brown30-road", "rule"]]);
    expect(roles(stairs(suggested("ISSprOM2019-2:999")), SPR)).toEqual([["main.colour", "brown30-road", "rule"]]);
    expect(roles(stairs(undefined), SPR)).toEqual([["main.colour", "brown30-road", "rule"]]);
  });

  it("one grey as area screen by rule and as canopy by hint", () => {
    expect(roles(area({ fill: C.grey35 }))).toEqual([["fill", "black-area-screen", "rule"]]);
    expect(roles(area({ fill: C.grey35, border: { main: { colour: C.black, widthUm: 100 } } }, suggested("ISOM2017-2:522")))).toEqual([
      ["fill", "black20-canopy", "match"],
      ["border.main.colour", "black100", "match"],
    ]);
  });

  it("two parts of one symbol take two roles; a class the entry lacks falls back to the rule", () => {
    // Suggested as ISOM 502 (wide road): the entry has a brown screen and a black, but no blue.
    const s = line({ ...road(C.brown50, C.black), glyphs: [{ glyph: { parts: [stroke(C.blue)], rotatable: true }, placement: { at: "start" } }] }, suggested("ISOM2017-2:502"));
    expect(roles(s)).toEqual([
      ["borders.left.colour", "black-road-outline", "match"],
      ["borders.right.colour", "black-road-outline", "match"],
      ["borders.backgroundColour", "brown50-road", "match"],
      ["glyphs[0].glyph.parts[0].colour", "blue100-line", "rule"],
    ]);
  });

  it("gives whites and purples their role", () => {
    expect(roles(area({ fill: C.yellow, patterns: dots(C.white) }, suggested("ISOM2017-2:402")))).toEqual([
      ["fill", "yellow100", "match"],
      ["patterns[0].glyph.parts[0].colour", "white-over-yellow", "match"],
    ]);
    expect(rolesOnly(point([C.purple], suggested("ISOM2017-2:703")))).toEqual(["purple-lower"]);
    expect(rolesOnly(textSym(C.purple, suggested("ISSprOM2019-2:704")), SPR)).toEqual(["purple-upper"]);
  });

  it("takes overlay entries, and gives no hint where the entry uses two ids of the colour's class", () => {
    // ISSkiOM 801.1 (very wide track): green-skio and the white mask.
    const track = line({ main: { colour: C.green, widthUm: 850, halo: { colour: C.white, widthUm: 850 } } }, suggested("ISSkiOM2019:801.1"));
    expect(rolesOnly(track)).toEqual(["green-skio", "white-skio"]);
    // ISSkiOM 808 (prepared area) uses green-skio and green100-area: both are green 100 % → no hint, the rule decides.
    expect(roles(area({ fill: C.green }, suggested("ISSkiOM2019:808")))).toEqual([["fill", "green100-area", "rule"]]);
  });

  it("orange-skio by hint on the 2022 edition (a row the edition lacks)", () => {
    const s = line({ main: { colour: C.skiOrange, widthUm: 360 } }, suggested("ISSkiOM2019:802.2"));
    expect(roleFromMatch(colourUses(s.render)[0], infosFor(ISOM, "iof2022"), s, rolePalette(ISOM, "iof2022"))).toBe("orange-skio");
  });
});

/**
 * The library as an oracle: every entry resolved against its own spec's
 * palette stack, its colours classified from CMYK alone. With no match the
 * rule must give each use the entry's own palette id, except whites and
 * purples (hint only) and the named uses below; with the entry as its own
 * hint every use must.
 */
describe("roleOfUse: the library as oracle", () => {
  const RULE_EXCEPTIONS: Record<string, string[]> = {
    "ISOM2017-2": [
      "101.b point-glyph brown100-line → brown100-point",
      "103.b point-glyph brown100-line → brown100-point",
    ],
    "ISSprOM2019-2": [
      "501.1 line-main black-road-outline → black100",
      "501.2 line-main black-road-outline → black100",
      "520.b area-border black-road-outline → black100",
      "532 line-main brown30-paved → brown30-road",
    ],
  };

  for (const spec of [ISOM, SPR]) {
    for (const edition of ["iof2024", "iof2022"] as const) {
      it(`${spec} on ${edition}`, () => {
        const lib = getSymbolLibrary(spec as "ISOM2017-2");
        const index = paletteIndex(edition, spec);
        const idAt = [...index.keys()];
        const infos: RoleColourInfo[] = idAt.map((id) => ({ class: classifyCmyk(paletteFor(edition, spec).find((p) => p.id === id)!.cmyk) }));
        const palette = rolePalette(spec, edition);
        const misses: string[] = [];
        let uses = 0, ruleHits = 0;
        for (const entry of lib.entries) {
          const render = resolveEntry(entry, index);
          const label = entry.code + (entry.variant ? `.${entry.variant}` : "");
          const found = colourUses(render);
          expect(new Set(found.map((u) => u.colour))).toEqual(new Set(renderColourRefs(render)));
          for (const use of found) {
            uses++;
            const want = idAt[use.colour];
            const rule = roleFromRule(use, infos, { render }, palette);
            if (rule === want) ruleHits++;
            else if (!/^(white|purple)/.test(want)) misses.push(`${label} ${use.part} ${want} → ${rule}`);
            expect(roleOfUse(use, infos, { render, match: { canonicalId: entry.id } }, palette), `${entry.id} ${formatColourPath(use.path)}`).toBe(want);
          }
        }
        expect(misses).toEqual(RULE_EXCEPTIONS[spec]);
        expect(ruleHits).toBe(spec === ISOM ? 203 : 183);
        expect(uses).toBe(spec === ISOM ? 249 : 226);
      });
    }
  }

  it("covers every reference of the overlay library too", () => {
    for (const lib of listSymbolLibraries()) {
      const index = paletteIndex(lib.palette, lib.spec);
      for (const entry of lib.entries) {
        const render = resolveEntry(entry, index);
        expect(new Set(colourUses(render).map((u) => u.colour))).toEqual(new Set(renderColourRefs(render)));
      }
    }
  });
});
