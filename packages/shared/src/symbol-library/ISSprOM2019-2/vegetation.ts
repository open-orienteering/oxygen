/** ISSprOM 2019-2 Rev 6 — 4xx Vegetation (green, yellow). Dimensions µm at 1:4 000. */

import { area, cross, disc, glyph, hatch, line, pattern, placed, point, ring, solid, spaced, stroke } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, entry } from "./common.js";

const K = C.black;
const G = C.greenArea;
const GP = C.greenPoint;
const W = C.whiteGB;

const whiteStripes = hatch(W, 400, 1500, 90);
const darkStripes = (colour: string) => hatch(colour, 1100, 1500, 90, { offsetUm: 750 });
const scattered = (fill: string, dotColour: string, dotUm: number, cellUm: number) =>
  area({ fill, patterns: [pattern(glyph(disc(dotColour, dotUm), false), cellUm, { angleDeg: 45, rotate: "never" })] });
const vineRows = (fill: string) =>
  area({ fill, patterns: [pattern(glyph(stroke(G, 300, [-1000, 0, 1000, 0])), { w: 2900, h: 1300 }, { shiftedRows: true })] });

export const vegetation: LibraryEntryInput[] = [
  entry("401", "Open land", "A", area({ fill: C.yellow }), { minimum: { areaUm2: 500_000 }, footprintM: 8 }),
  entry("402", "Open land with scattered trees", "A", scattered(C.yellow, C.whiteYellow, 600, 750), {
    minimum: { widthUm: 2200, areaUm2: 6_250_000 }, footprintM: 100, notes: "Yellow with white holes ø 0.6 mm on a 0.75 mm grid at 45°.",
  }),
  entry("402", "Open land with scattered bushes", "A", scattered(C.yellow, C.green60, 600, 750), { variant: "b", description: "Green 60 % dots instead of white holes." }),
  entry("403", "Rough open land", "A", area({ fill: C.yellow50 }), { minimum: { widthUm: 400, areaUm2: 1_000_000 }, footprintM: 16 }),
  entry("404", "Rough open land with scattered trees", "A", scattered(C.yellow50, C.whiteYellow, 700, 1000), {
    minimum: { widthUm: 2500, areaUm2: 6_250_000 }, footprintM: 100, notes: "Yellow 50 % with white holes ø 0.7 mm (Rev 6; 0.8 before) on a 1.0 mm grid at 45°.",
  }),
  entry("404", "Rough open land with scattered bushes", "A", scattered(C.yellow50, C.green60, 700, 1000), { variant: "b", description: "Green 60 % dots instead of white holes." }),
  entry("405", "Forest", "A", area({ fill: W }), { minimum: { areaUm2: 500_000 }, notes: "White knock-out over green and brown screens." }),

  entry("406", "Vegetation: slow running", "A", area({ fill: C.green30 }), { minimum: { widthUm: 400, areaUm2: 1_000_000 }, footprintM: 16 }),
  entry("406", "Vegetation: slow running, normal running in one direction", "A", area({ fill: C.green30, hatches: [whiteStripes] }), {
    variant: "b", description: "White stripes 0.4 / 1.5 mm in the direction of better running.",
  }),
  entry("407", "Vegetation: slow running, good visibility", "A", area({ hatches: [hatch(G, 120, 840, 90, { rotate: "never" })] }), {
    notes: "Green north–south lines 0.12 mm, 0.84 mm (CC) apart.",
  }),
  entry("408", "Vegetation: walk", "A", area({ fill: C.green60 }), { minimum: { widthUm: 400, areaUm2: 500_000 }, footprintM: 8 }),
  entry("408", "Vegetation: walk, normal running in one direction", "A", area({ fill: C.green60, hatches: [whiteStripes] }), { variant: "b", description: "White stripes 0.4 / 1.5 mm." }),
  entry("408", "Vegetation: walk, slow running in one direction", "A", area({ fill: C.green30, hatches: [darkStripes(C.green60)] }), {
    variant: "c", description: "Green 60 % stripes 1.1 / 1.5 mm on green 30 %.",
  }),
  entry("409", "Vegetation: walk, good visibility", "A", area({ hatches: [hatch(G, 140, 420, 90, { rotate: "never" })] }), {
    notes: "Green north–south lines 0.14 mm, 0.42 mm (CC) apart.",
  }),
  entry("410", "Vegetation: fight", "A", area({ fill: G }), { minimum: { widthUm: 250, areaUm2: 300_000 }, footprintM: 5 }),
  entry("410", "Vegetation: fight, normal running in one direction", "A", area({ fill: G, hatches: [whiteStripes] }), { variant: "b", description: "White stripes 0.4 / 1.5 mm." }),
  entry("410", "Vegetation: fight, slow running in one direction", "A", area({ fill: C.green30, hatches: [darkStripes(G)] }), {
    variant: "c", description: "Green 100 % stripes 1.1 / 1.5 mm on green 30 %.",
  }),
  entry("410", "Vegetation: fight, walk in one direction", "A", area({ fill: C.green60, hatches: [darkStripes(G)] }), {
    variant: "d", description: "Green 100 % stripes 1.1 / 1.5 mm on green 60 %.",
  }),
  entry("411", "Uncrossable vegetation", "A", area({ fill: C.darkGreenArea }), { minimum: { widthUm: 400, areaUm2: 300_000 }, footprintM: 5, notes: "Dark green." }),
  entry("411", "Uncrossable vegetation, minimum width", "L", line({ main: solid("darkgreen-line", 400) }), {
    variant: "b", description: "Hedge drawn as a 0.4 mm dark green line.",
  }),

  entry("412", "Cultivated land", "A", area({ fill: C.yellow, patterns: [pattern(glyph(disc(C.blackCultivated, 200), false), 800, { rotate: "never" })] }), {
    minimum: { widthUm: 3000, areaUm2: 9_000_000 }, footprintM: 144, notes: "Yellow with black dots ø 0.2 mm on a 0.8 mm (CC) orthogonal grid.",
  }),
  entry("413", "Orchard", "A", area({ fill: C.yellow, patterns: [pattern(glyph(disc(G, 680), false), 1200)] }), {
    minimum: { widthUm: 2000, areaUm2: 4_000_000 }, footprintM: 64, notes: "Yellow with green dots ø 0.68 mm on a 1.2 mm grid following the rows.",
  }),
  entry("413", "Orchard, rough open land", "A", area({ fill: C.yellow50, patterns: [pattern(glyph(disc(G, 680), false), 1200)] }), { variant: "b", description: "Yellow 50 % background." }),
  entry("414", "Vineyard or similar", "A", vineRows(C.yellow), {
    minimum: { widthUm: 2000, areaUm2: 4_000_000 }, footprintM: 64, notes: "Green dashes 2.0 × 0.3 mm, 0.9 mm gaps, rows 1.3 mm apart, alternate rows shifted; direction from the object angle.",
  }),
  entry("414", "Vineyard or similar, rough open land", "A", vineRows(C.yellow50), { variant: "b", description: "Yellow 50 % background." }),
  entry("415", "Distinct cultivation boundary", "L", line({ main: solid(K, 150) }), { minimum: { lengthUm: 1000 }, footprintM: 4, notes: "0.15 mm (Rev 6; 0.1 before)." }),
  entry("416", "Distinct vegetation boundary", "L", line({ glyphs: [placed(glyph(disc(K, 250), false), spaced(600, { firstUm: 0, lastUm: 0, minCount: 5, minCountClosed: 5 }))] }), {
    minimum: { lengthUm: 2650 }, footprintM: 10.6, notes: "Black dots ø 0.25 mm every 0.6 mm (CC), five dots minimum.",
  }),
  entry("417", "Prominent large tree", "P", point([disc(W, 1400), ring(GP, 1200, 250)]), {
    footprintM: 4.8, notes: "Green ring 1.2 mm outside measure, 0.25 mm wide, on a white mask ø 1.4 mm.",
  }),
  entry("418", "Prominent bush or small tree", "P", point([disc(W, 1200), disc(GP, 800)]), { footprintM: 3.2, notes: "Green dot ø 0.8 mm on a white mask 0.2 mm wider all round." }),
  entry("419", "Prominent vegetation feature", "P", point([...cross(W, 500, 849), ...cross(GP, 250, 724)]), {
    footprintM: 4.8, notes: "Green × 0.25 mm, 1.2 mm outside measure, on a white mask.",
  }),
];
