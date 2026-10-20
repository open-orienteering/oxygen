/**
 * ISSprOM 2019-2 Rev 6 — 7xx Course planning symbols (purple). Dimensions
 * µm at 1:4 000. Purple role per 03 §2.4: 704 and 710.2 are *upper* here.
 */

import { area, atEnd, atStart, dashed, glyph, hatch, line, placed, point, ringCC, solid, stroke } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, entry } from "./common.js";

const PL = C.purpleLower;
const PU = C.purpleUpper;

const triangleOutline = (colour: string, widthUm: number, sideUm: number) => {
  const r = sideUm / Math.sqrt(3);
  return stroke(colour, widthUm, [0, r, -sideUm / 2, -r / 2, sideUm / 2, -r / 2].map(Math.round), { closed: true });
};

const oobHatch = hatch(PU, 400, 1200, 45, { rotate: "never" });

export const course: LibraryEntryInput[] = [
  entry("701", "Start", "P", point(triangleOutline(PL, 350, 7000), "object"), { purpleRole: "lower", notes: "Triangle side 7.0 mm, 0.35 mm line; apex towards the first control." }),
  entry("702", "Map issue point", "P", point(stroke(PU, 600, [-1250, 0, 1250, 0]), "object"), { purpleRole: "upper", notes: "Bar 2.5 × 0.6 mm." }),
  entry("703", "Control point", "P", point(ringCC(PL, 6000, 350)), { purpleRole: "lower", footprintM: 24, notes: "Circle ø 6.0 mm (CC), 0.35 mm." }),
  entry("704", "Control number", "T", { type: "text", fontFamily: "liberation-sans", fontSizeUm: 5600, digitHeightUm: 4000, colour: PU }, {
    purpleRole: "upper", notes: "Arial 4.0 mm digit height, non-bold; upper purple in ISSprOM.",
  }),
  entry("704", "Control number, with white outline", "T", { type: "text", fontFamily: "liberation-sans", fontSizeUm: 5600, digitHeightUm: 4000, colour: PU, halo: { colour: C.whiteUpper, widthUm: 150 } }, {
    purpleRole: "upper", variant: "b", description: "Optional 0.1–0.15 mm white outline for building-dense maps.",
  }),
  entry("705", "Course line", "L", line({ main: solid(PL, 350) }), { purpleRole: "lower" }),
  entry("706", "Finish", "P", point([ringCC(PL, 5000, 350), ringCC(PL, 7000, 350)]), { purpleRole: "lower", notes: "Concentric circles ø 5.0 and 7.0 mm (CC), 0.35 mm." }),
  entry("707", "Marked route", "L", line({ main: dashed(PU, 350, 2000, 500) }), { purpleRole: "upper", notes: "Dashes 2.0 / 0.5 mm, 0.35 mm." }),
  entry("708", "Out-of-bounds boundary", "L", line({ main: solid(PL, 1000) }), { purpleRole: "lower" }),
  entry("709", "Out-of-bounds area", "A", area({ hatches: [oobHatch] }), {
    purpleRole: "upper", minimum: { widthUm: 3000, areaUm2: 9_000_000 }, footprintM: 144, notes: "Stripes 0.4 mm (Rev 6; 0.25 before) at 45°, 1.2 mm (CC) apart; no bounding line.",
  }),
  entry("709", "Out-of-bounds area, solid boundary", "A", area({ hatches: [oobHatch], border: { main: solid(PU, 200) } }), {
    purpleRole: "upper", variant: "b", description: "Boundary marked continuously: 0.2 mm solid line.",
  }),
  entry("709", "Out-of-bounds area, dashed boundary", "A", area({ hatches: [oobHatch], border: { main: dashed(PU, 200, 3000, 500) } }), {
    purpleRole: "upper", variant: "c", description: "Intermittent marking: 0.2 mm line dashed 3.0 / 0.5 mm.",
  }),
  entry("710.1", "Crossing point", "P", point([stroke(PL, 500, [-2000, 1050, -700, 750, 700, 750, 2000, 1050]), stroke(PL, 500, [-2000, -1050, -700, -750, 700, -750, 2000, -1050])], "object"), {
    purpleRole: "lower", notes: "Two 0.5 mm lines (Rev 6; 0.35 before) 1.0 mm (inside measure) apart curving outwards, 4.5 mm overall (Rev 6; 3.0 before).",
  }),
  entry(
    "710.2", "Crossing section", "L",
    line({
      main: solid(PU, 350),
      glyphs: [
        placed(glyph(stroke(PU, 350, [0, 0, -600, 0, -900, 150, -1500, 650])), atStart),
        placed(glyph(stroke(PU, 350, [0, 0, 600, 0, 900, 150, 1500, 650])), atEnd),
      ],
    }),
    { purpleRole: "upper", notes: "0.35 mm line along the crossing with both ends curving 1.5 mm outwards to one side; one object per side." },
  ),
  entry("714", "Temporary construction or closed area", "A", area({ fill: C.purple50, border: { main: solid(PU, 100) } }), {
    purpleRole: "upper", minimum: { widthUm: 500, areaUm2: 250_000 }, footprintM: 4, notes: "Purple 50 % with a 0.1 mm purple outline.",
  }),
  entry("715", "Continuing point after map exchange", "P", point([ringCC(PL, 6000, 350), triangleOutline(PL, 350, 3000)], "object"), {
    purpleRole: "lower", notes: "Control circle ø 6.0 mm (CC) with a 0.35 mm triangle inside pointing towards the next control.",
  }),
];
