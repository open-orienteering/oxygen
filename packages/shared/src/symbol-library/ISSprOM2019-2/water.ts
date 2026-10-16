/** ISSprOM 2019-2 Rev 6 — 3xx Water and marsh (blue). Dimensions µm at 1:4 000. */

import { arcCoords, area, dashed, disc, fillPart, glyph, hatch, line, pattern, placed, point, solid, spaced, stroke } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, DASH_NOTE, entry } from "./common.js";

const BL = C.blue;
const BA = C.blueArea;
const K = C.black;

const star = (colour: string, widthUm: number, armUm: number) =>
  [0, 1, 2, 3, 4].map((i) => {
    const a = ((90 + 72 * i) * Math.PI) / 180;
    return stroke(colour, widthUm, [0, 0, Math.round(armUm * Math.cos(a)), Math.round(armUm * Math.sin(a))]);
  });

export const water: LibraryEntryInput[] = [
  entry("301", "Uncrossable body of water", "A", area({ fill: BA, border: { main: solid(K, 180, { join: "bevel" }) } }), {
    minimum: { widthUm: 300, areaUm2: 500_000 }, footprintM: 8, notes: "Blue 100 % with a 0.18 mm black bank line.",
  }),
  entry("301", "Uncrossable body of water, dominant", "A", area({ fill: C.blue70, border: { main: solid(K, 180, { join: "bevel" }) } }), {
    variant: "b", description: "Blue 70 % for dominant water areas, black bank line.",
  }),
  entry("302", "Shallow body of water", "A", area({ fill: C.blue30, border: { main: solid(BL, 180) } }), {
    minimum: { widthUm: 300, areaUm2: 500_000 }, footprintM: 8, notes: "Blue 30 % with a 0.18 mm blue outline (renamed from 'Crossable body of water' in Rev 6).",
  }),
  entry("303", "Waterhole", "P", point(fillPart(BL, [-546, 409, -274, 409, 0, -217, 274, 409, 546, 409, 0, -841]), "north"), {
    footprintM: 4.4, notes: "Blue V 1.1 × 1.25 mm (outside measure), arms 0.25 mm.",
  }),
  entry("305", "Small crossable watercourse", "L", line({ main: solid(BL, 210) }), { minimum: { lengthUm: 1000 }, footprintM: 4 }),
  entry("306", "Minor / seasonal watercourse", "L", line({ main: dashed(BL, 210, 1870, 370) }), { minimum: { lengthUm: 4110 }, footprintM: 16.5, notes: DASH_NOTE }),
  entry("307", "Uncrossable marsh", "A", area({ hatches: [hatch(BA, 250, 500, 0, { rotate: "never" })], border: { main: solid(K, 180) } }), {
    notes: "Horizontal blue lines 0.25 mm, 0.5 mm (CC) apart, 0.18 mm black outline; minimum two lines.",
  }),
  entry("307", "Uncrossable marsh, no outline", "A", area({ hatches: [hatch(BA, 250, 500, 0, { rotate: "never" })] }), {
    variant: "b", description: "Hatching only, outline drawn by another black line.",
  }),
  entry("308", "Marsh", "A", area({ hatches: [hatch(BA, 120, 380, 0, { rotate: "never" })] }), { notes: "Horizontal blue lines 0.12 mm, 0.38 mm (CC) apart; minimum two lines." }),
  entry("309", "Narrow marsh", "L", line({ glyphs: [placed(glyph(disc(BL, 370), false), spaced(600, { firstUm: 0, lastUm: 0, minCount: 2 }))] }), {
    minimum: { lengthUm: 1000 }, footprintM: 4, notes: "Blue dots ø 0.37 mm every 0.6 mm (CC); two dots minimum.",
  }),
  entry("310", "Indistinct marsh", "A", area({ patterns: [pattern(glyph(stroke(BA, 120, [-500, 0, 500, 0]), false), { w: 1350, h: 380 }, { shiftedRows: true, rotate: "never" })] }), {
    notes: "Blue dashes 1.0 × 0.12 mm, 0.35 mm gaps, rows 0.38 mm (CC) apart, alternate rows shifted half a period.",
  }),
  entry("311", "Small fountain or well", "P", point(stroke(BL, 250, [-325, -325, 325, -325, 325, 325, -325, 325], { closed: true })), {
    footprintM: 3.6, notes: "Blue square 0.9 mm outside measure, 0.25 mm line.",
  }),
  entry("312", "Spring", "P", point(stroke(BL, 250, [475, 135, 475, -127, ...arcCoords(0, -127, 475, 213, 0, -180, 10), -475, 135]), "object"), {
    footprintM: 4.8, notes: "Blue U 1.2 × 0.6 mm (outside measure), opening towards the flow.",
  }),
  entry("313", "Prominent water feature", "P", point(star(BL, 250, 475)), { footprintM: 4.8, notes: "Five spokes 0.25 mm, 1.2 mm outside measure." }),
];
