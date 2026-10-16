/** ISOM 2017-2 Rev 6 — 4xx Vegetation (green, yellow). Dimensions µm at 1:15 000. */

import { area, cross, dashed, disc, glyph, hatch, line, pattern, placed, point, ring, solid, spaced, stroke } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, entry } from "./common.js";

const K = C.black;
const G = C.greenArea;
const GP = C.greenPoint;
const W = C.whiteGB;

/** Runnability stripes: 0.4 mm white every 1.5 mm, direction set per object. */
const whiteStripes = hatch(W, 400, 1500, 90);
/** The complementary 1.1 mm stripes of the darker screen on the lighter background. */
const darkStripes = (colour: string) => hatch(colour, 1100, 1500, 90, { offsetUm: 750 });

const scattered = (fill: string, dotColour: string, dotUm: number, cellUm: number) =>
  area({ fill, patterns: [pattern(glyph(disc(dotColour, dotUm), false), cellUm, { angleDeg: 45, rotate: "never" })] });

export const vegetation: LibraryEntryInput[] = [
  entry("401", "Open land", "A", area({ fill: C.yellow }), { minimum: { areaUm2: 302_500 }, footprintM: 8 }),
  entry("401", "Open land, yellow 75 %", "A", area({ fill: "yellow75" }), { variant: "b", description: "Reduced yellow where 100 % would dominate the map." }),

  entry("402", "Open land with scattered trees", "A", scattered(C.yellow, C.whiteYellow, 400, 700), {
    minimum: { widthUm: 1500, areaUm2: 4_000_000 }, footprintM: 22.5, notes: "Yellow with white holes ø 0.4 mm on a 0.7 mm grid at 45°.",
  }),
  entry("402", "Open land with scattered bushes", "A", scattered(C.yellow, C.green60, 400, 700), {
    variant: "b", description: "Green 60 % dots instead of white holes (bushes).",
  }),
  entry("403", "Rough open land", "A", area({ fill: C.yellow50 }), { minimum: { areaUm2: 1_000_000 }, footprintM: 15 }),
  entry("404", "Rough open land with scattered trees", "A", scattered(C.yellow50, C.whiteYellow, 500, 800), {
    minimum: { widthUm: 1500, areaUm2: 6_250_000 }, footprintM: 22.5, notes: "Yellow 50 % with white holes ø 0.5 mm on a 0.8 mm grid at 45°.",
  }),
  entry("404", "Rough open land with scattered bushes", "A", scattered(C.yellow50, C.green60, 500, 800), {
    variant: "b", description: "Green 60 % dots instead of white holes (bushes).",
  }),
  entry("405", "Forest", "A", area({ fill: W }), { minimum: { areaUm2: 1_000_000 }, footprintM: 15, notes: "White knock-out over green and brown screens." }),

  entry("406", "Vegetation: slow running", "A", area({ fill: C.green30 }), { minimum: { widthUm: 400, areaUm2: 1_000_000 }, footprintM: 15 }),
  entry("406", "Vegetation: slow running, normal running in one direction", "A", area({ fill: C.green30, hatches: [whiteStripes] }), {
    variant: "b", description: "White stripes 0.4 / 1.5 mm in the direction of better running.",
  }),
  entry("407", "Vegetation: slow running, good visibility", "A", area({ hatches: [hatch(G, 120, 840, 90, { rotate: "never" })] }), {
    minimum: { areaUm2: 1_000_000 }, notes: "Green north–south lines 0.12 mm, 0.84 mm (CC) apart.",
  }),
  entry("408", "Vegetation: walk", "A", area({ fill: C.green60 }), { minimum: { widthUm: 300, areaUm2: 490_000 }, footprintM: 10.5 }),
  entry("408", "Vegetation: walk, normal running in one direction", "A", area({ fill: C.green60, hatches: [whiteStripes] }), {
    variant: "b", description: "White stripes 0.4 / 1.5 mm.",
  }),
  entry("408", "Vegetation: walk, slow running in one direction", "A", area({ fill: C.green30, hatches: [darkStripes(C.green60)] }), {
    variant: "c", description: "Green 60 % stripes 1.1 / 1.5 mm on green 30 %.",
  }),
  entry("409", "Vegetation: walk, good visibility", "A", area({ hatches: [hatch(G, 140, 420, 90, { rotate: "never" })] }), {
    minimum: { areaUm2: 1_000_000 }, notes: "Green north–south lines 0.14 mm, 0.42 mm (CC) apart.",
  }),
  entry("410", "Vegetation: fight", "A", area({ fill: G }), { minimum: { widthUm: 250, areaUm2: 302_500 }, footprintM: 8 }),
  entry("410", "Vegetation: fight, normal running in one direction", "A", area({ fill: G, hatches: [whiteStripes] }), {
    variant: "b", description: "White stripes 0.4 / 1.5 mm.",
  }),
  entry("410", "Vegetation: fight, slow running in one direction", "A", area({ fill: C.green30, hatches: [darkStripes(G)] }), {
    variant: "c", description: "Green 100 % stripes 1.1 / 1.5 mm on green 30 %.",
  }),
  entry("410", "Vegetation: fight, walk in one direction", "A", area({ fill: C.green60, hatches: [darkStripes(G)] }), {
    variant: "d", description: "Green 100 % stripes 1.1 / 1.5 mm on green 60 %.",
  }),

  entry("412", "Cultivated land", "A", area({ fill: C.yellow, patterns: [pattern(glyph(disc(C.blackCultivated, 200), false), 800, { rotate: "never" })] }), {
    notes: "Yellow with black dots ø 0.2 mm on a 0.8 mm (CC) orthogonal grid.",
  }),
  entry("413", "Orchard", "A", area({ fill: C.yellow, patterns: [pattern(glyph(disc(G, 450), false), 800)] }), {
    notes: "Yellow with green dots ø 0.45 mm on a 0.8 mm (CC) grid; the grid may follow the tree rows (object angle).",
  }),
  entry("413", "Orchard, rough open land", "A", area({ fill: C.yellow50, patterns: [pattern(glyph(disc(G, 450), false), 800)] }), {
    variant: "b", description: "Yellow 50 % background.",
  }),
  entry("414", "Vineyard or similar", "A", area({ fill: C.yellow, patterns: [pattern(glyph(stroke(G, 200, [-650, 0, 650, 0])), { w: 1900, h: 850 }, { shiftedRows: true })] }), {
    notes: "Yellow with green dashes 1.3 × 0.2 mm, 0.6 mm gaps, rows 0.85 mm apart, alternate rows shifted; row direction from the object angle.",
  }),
  entry("414", "Vineyard or similar, rough open land", "A", area({ fill: C.yellow50, patterns: [pattern(glyph(stroke(G, 200, [-650, 0, 650, 0])), { w: 1900, h: 850 }, { shiftedRows: true })] }), {
    variant: "b", description: "Yellow 50 % background.",
  }),

  entry("415", "Distinct cultivation boundary", "L", line({ main: solid(K, 100) })),
  entry("416", "Distinct vegetation boundary", "L", line({ glyphs: [placed(glyph(disc(K, 220), false), spaced(450, { firstUm: 0, lastUm: 0, minCount: 5, minCountClosed: 5 }))] }), {
    minimum: { lengthUm: 2000 }, footprintM: 30, notes: "Black dots ø 0.22 mm every 0.45 mm (CC), five dots minimum.",
  }),
  entry("416", "Distinct vegetation boundary, green dashed line", "L", line({ main: dashed(GP, 140, 300, 200) }), {
    variant: "b", description: "Alternative implementation: green dashes 0.3 / 0.2 mm, 0.14 mm wide (one implementation per map).", minimum: { lengthUm: 1800 }, footprintM: 27,
  }),

  entry("417", "Prominent large tree", "P", point([disc(W, 1100), ring(GP, 900, 180)]), {
    footprintM: 13.5, notes: "Green ring 0.9 mm outside measure, 0.18 mm wide, on a white mask ø 1.1 mm.",
  }),
  entry("418", "Prominent bush or tree", "P", point([disc(W, 1000), disc(GP, 600)]), {
    footprintM: 9, notes: "Green dot ø 0.6 mm on a white mask 0.2 mm wider all round.",
  }),
  entry("419", "Prominent vegetation feature", "P", point([...cross(W, 360, 390), ...cross(GP, 180, 390)]), {
    footprintM: 13.5, notes: "Green × 0.18 mm, 0.9 mm outside measure, on a white mask 0.36 mm wide.",
  }),
];
