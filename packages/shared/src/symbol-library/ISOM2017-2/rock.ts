/** ISOM 2017-2 Rev 6 — 2xx Rock and boulders (black). Dimensions µm at 1:15 000. */

import { area, border, disc, doubleLine, fillPart, glyph, line, pattern, placed, point, ring, solid, spaced, tick, triangle } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, entry } from "./common.js";

const K = C.black;

/** Cliff tags: 0.12 mm wide, 0.4 mm beyond the top line's edge, 0.5 mm apart, downhill (right) side. */
const cliffTags = (mainWidthUm: number) =>
  placed(glyph(tick(K, 120, 0, -(400 + mainWidthUm / 2))), spaced(500, { firstUm: 60, lastUm: 60, minCount: 2 }));

/** Boulder-field triangles: side 0.8 mm (spec drawing), two per 1.2 mm cell on a shifted grid. */
const boulderTriangle = (sideUm: number) => triangle(K, sideUm);

export const rock: LibraryEntryInput[] = [
  entry("201", "Impassable cliff", "L", line({ main: solid(K, 350), glyphs: [cliffTags(350)] }), {
    minimum: { lengthUm: 600 }, footprintM: 9, notes: "Top line 0.35 mm, tags 0.12 mm × 0.4 mm every 0.5 mm (CC); minimum 0.6 mm outside measure.",
  }),
  entry("201", "Impassable cliff, top line", "L", line({ main: solid(K, 350, { cap: "round", join: "round" }) }), { variant: "b", description: "Top line without tags (tags drawn as separate objects).", notes: "Round joins and ends as OCAD's ISOM 2017-2 set draws the no-tag baseline (lineStyle 1); user decision 2026-10-24, a deviation from the flat spec drawing. The tagged 201 stays miter / flat." }),
  entry("201", "Impassable cliff, tag line", "L", line({ main: solid(K, 120) }), { variant: "c", description: "A single tag drawn as its own line object." }),

  entry("202", "Cliff", "L", line({ main: solid(K, 250, { cap: "round", join: "round" }) }), {
    minimum: { lengthUm: 600 }, footprintM: 9, notes: "Passable cliff without tags; round joins and ends as OCAD's ISOM 2017-2 set draws it (lineStyle 1), user decision 2026-10-24 — a deviation from the flat spec drawing.",
  }),
  entry("202", "Cliff, with tags", "L", line({ main: solid(K, 250, { cap: "round", join: "round" }), glyphs: [cliffTags(250)] }), {
    variant: "b", description: "Passable cliff with tags showing the direction of fall.", notes: "Round joins and ends like 202 (OCAD set, user decision 2026-10-24).", minimum: { lengthUm: 600 },
  }),

  entry("203.1", "Rocky pit or cave", "P", point(fillPart(K, [154, 302, 350, 302, 0, -489, -350, 302, -154, 302, 0, -50]), "north"), {
    notes: "V shape 0.7 mm (outside measure) wide, arms 0.16 mm; orientated to north (OCAD template sets mark it non-rotatable; a cave with a distinct entrance should point into the cave).",
  }),
  entry("203.2", "Dangerous pit", "P", point([disc(C.whiteGB, 900), ring(K, 900, 350)]), {
    footprintM: 13.5, notes: "Rev 6 addition: black ring 0.9 mm outside measure, 0.35 mm wide, white inside.",
  }),

  entry("204", "Boulder", "P", point(disc(K, 400)), { footprintM: 6 }),
  entry("205", "Large boulder", "P", point(disc(K, 600)), { footprintM: 9 }),
  entry("206", "Gigantic boulder or rock pillar", "A", area({ fill: K }), {
    minimum: { widthUm: 250, areaUm2: 300_000 }, footprintM: 3.75,
  }),
  entry("207", "Boulder cluster", "P", point(triangle(K, 800)), {
    notes: "Equilateral triangle, side 0.8 mm, apex north; the large variant (side 0.96 mm) is 207.b.",
  }),
  entry("207", "Boulder cluster, large", "P", point(triangle(K, 960)), { variant: "b", description: "Larger boulder cluster (side 0.96 mm)." }),

  entry(
    "208", "Boulder field", "A",
    area({ patterns: [pattern(glyph(boulderTriangle(600), false), { w: 1200, h: 1200 }, { shiftedRows: true })] }),
    { notes: "Triangles side 0.6 mm (0.8 mm enlarged allowed), spacing max 1.2 mm (CC), min 0.75 mm; the spec's random placement is drawn as a shifted grid (03 §6.2)." },
  ),
  entry(
    "209", "Dense boulder field", "A",
    area({ patterns: [pattern(glyph(boulderTriangle(600), false), { w: 800, h: 800 }, { shiftedRows: true })] }),
    { notes: "As 208 at the spec's minimum spacing (0.75–0.8 mm CC)." },
  ),

  entry("210", "Stony ground, slow running", "A", stonyGround(600), { notes: "Black dots ø 0.2 mm, max 0.6 mm (CC); regular grid." }),
  entry("211", "Stony ground, walk", "A", stonyGround(500), { notes: "Black dots ø 0.2 mm; denser than 210 (grid 0.5 mm)." }),
  entry("212", "Stony ground, fight", "A", stonyGround(380), { notes: "Black dots ø 0.2 mm; densest stony ground (grid 0.38 mm)." }),

  entry(
    "213", "Sandy ground", "A",
    area({ fill: C.yellow50, patterns: [pattern(glyph(disc(C.blackCultivated, 160), false), 450, { angleDeg: 45, rotate: "never" })] }),
    { minimum: { areaUm2: 1_000_000 }, footprintM: 15, notes: "Yellow 50 % with black dots ø 0.16 mm on a 0.45 mm grid at 45°." },
  ),
  entry("214", "Bare rock", "A", area({ fill: C.blackScreen }), { minimum: { areaUm2: 1_000_000 }, footprintM: 15, notes: "Black 35 % (Rev 6; 30 % before)." }),
  entry("215", "Trench", "L", line({ borders: doubleLine(border(K, 100, 100)) }), {
    minimum: { lengthUm: 1000 }, footprintM: 15, notes: "Two 0.1 mm lines with a 0.1 mm gap (0.3 mm outside measure); drawn as borders ±0.1 mm around an empty centre line.",
  }),
];

function stonyGround(cellUm: number) {
  return area({ patterns: [pattern(glyph(disc(K, 200), false), cellUm)] });
}
