/** ISOM 2017-2 Rev 6 — 3xx Water and marsh (blue). Dimensions µm at 1:15 000. */

import { arcCoords, area, dashed, disc, fillPart, glyph, hatch, line, pattern, placed, point, solid, spaced, stroke } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, DASH_NOTE, entry } from "./common.js";

const BL = C.blueLine;
const BP = C.bluePoint;
const BA = C.blueArea;
const K = C.black;

/** Five spokes 72° apart, first pointing north. */
const star = (colour: string, widthUm: number, armUm: number) =>
  [0, 1, 2, 3, 4].map((i) => {
    const a = ((90 + 72 * i) * Math.PI) / 180;
    return stroke(colour, widthUm, [0, 0, Math.round(armUm * Math.cos(a)), Math.round(armUm * Math.sin(a))]);
  });

export const water: LibraryEntryInput[] = [
  entry("301", "Uncrossable body of water", "A", area({ fill: BA, border: { main: solid(K, 120, { join: "bevel" }) } }), {
    minimum: { widthUm: 300, areaUm2: 302_500 }, footprintM: 8, notes: "Blue 100 % with a 0.12 mm black bank line (Rev 6; 0.18 before).",
  }),
  entry("301", "Uncrossable body of water, dominant", "A", area({ fill: C.blue70, border: { main: solid(K, 120, { join: "bevel" }) } }), {
    variant: "b", description: "Blue 70 % for dominant water areas (large lakes), black bank line.",
  }),

  entry("302", "Shallow body of water", "A", area({ fill: C.blue50, border: { main: solid(BL, 100) } }), {
    minimum: { widthUm: 300, areaUm2: 490_000 }, footprintM: 10.5, notes: "Blue 50 % with a 0.1 mm solid blue outline.",
  }),
  entry("302", "Shallow body of water, dashed outline", "A", area({ fill: C.blue50, border: { main: dashed(BL, 100, 1250, 250) } }), {
    variant: "b", description: "Indistinct edge: 0.1 mm blue outline dashed 1.25 / 0.25 mm.", notes: DASH_NOTE,
  }),
  entry("302", "Small shallow body of water, full colour", "A", area({ fill: BA }), {
    variant: "c", description: "Small shallow water drawn in full blue without outline.", minimum: { widthUm: 300, areaUm2: 302_500 }, footprintM: 8,
  }),

  entry("303", "Waterhole", "P", point(fillPart(BP, [154, 302, 350, 302, 0, -489, -350, 302, -154, 302, 0, -50]), "north"), {
    footprintM: 10.5, notes: "Blue V shape 0.7 × 0.8 mm (as 112).",
  }),
  entry("304", "Crossable watercourse", "L", line({ main: solid(BL, 300) }), { minimum: { lengthUm: 1000 } }),
  entry("305", "Small crossable watercourse", "L", line({ main: solid(BL, 180) }), { minimum: { lengthUm: 1000 } }),
  entry("306", "Minor/seasonal water channel", "L", line({ main: dashed(BL, 180, 1250, 250) }), {
    minimum: { lengthUm: 2750 }, notes: `Two dashes minimum. ${DASH_NOTE}`,
  }),

  entry("307", "Uncrossable marsh", "A", area({ hatches: [hatch(BA, 250, 500, 0, { rotate: "never" })], border: { main: solid(K, 120) } }), {
    minimum: { widthUm: 800 }, notes: "Horizontal blue lines 0.25 mm, 0.5 mm (CC) apart, 0.12 mm black outline (Rev 6).",
  }),
  entry("307", "Uncrossable marsh, no outline", "A", area({ hatches: [hatch(BA, 250, 500, 0, { rotate: "never" })] }), {
    variant: "b", description: "Hatching only, where the outline is drawn by another black line symbol.",
  }),
  entry("308", "Marsh", "A", area({ hatches: [hatch(BA, 100, 300, 0, { rotate: "never" })] }), {
    notes: "Horizontal blue lines 0.1 mm, 0.3 mm (CC) apart; minimum graphic two lines 0.5 mm long, 0.12 mm.",
  }),
  entry("309", "Narrow marsh", "L", line({ glyphs: [placed(glyph(disc(BL, 250), false), spaced(450, { firstUm: 0, lastUm: 0, minCount: 3 }))] }), {
    minimum: { lengthUm: 1150 }, notes: "Blue dots ø 0.25 mm every 0.45 mm (CC), three dots minimum.",
  }),
  entry(
    "310", "Indistinct marsh", "A",
    area({ patterns: [pattern(glyph(stroke(BA, 100, [-450, 0, 450, 0]), false), { w: 1150, h: 300 }, { shiftedRows: true, rotate: "never" })] }),
    { minimum: { areaUm2: 2_000_000 }, notes: "Blue dashes 0.9 × 0.1 mm, gap 0.25 mm, rows 0.3 mm (CC) apart, alternate rows shifted half a period." },
  ),

  entry("311", "Well, fountain or water tank", "P", point(stroke(BP, 180, [-310, -310, 310, -310, 310, 310, -310, 310], { closed: true })), {
    footprintM: 12, notes: "Blue square 0.8 mm outside measure, 0.18 mm line.",
  }),
  entry("312", "Spring", "P", point(stroke(BP, 180, [360, 234, 360, 36, ...arcCoords(0, 36, 360, 162, 0, -180, 10), -360, 234]), "object"), {
    footprintM: 13.5, notes: "Blue U shape 0.9 mm wide (outside measure), opening towards the flow.",
  }),
  entry("313", "Prominent water feature", "P", point(star(BP, 160, 370)), { footprintM: 13.5, notes: "Five spokes 0.16 mm, 0.9 mm outside measure." }),
];
