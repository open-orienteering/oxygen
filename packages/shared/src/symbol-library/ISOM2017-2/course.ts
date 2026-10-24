/**
 * ISOM 2017-2 Rev 6 — 7xx Course planning symbols (purple). Dimensions µm
 * at 1:15 000; the course layer applies the print-scale factor (03 §6.6).
 * Purple role per 03 §2.4, except 704 (upper; decision log).
 */

import { arcCoords, area, atEnd, atStart, border, cross, dashed, glyph, hatch, line, placed, plus, point, ringCC, solid, spaced, stroke } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, entry } from "./common.js";

const PL = C.purpleLower;
const PU = C.purpleUpper;

/** Equilateral triangle outline by side, centroid at the origin, apex along +y. */
const triangleOutline = (colour: string, widthUm: number, sideUm: number) => {
  const r = sideUm / Math.sqrt(3);
  return stroke(colour, widthUm, [0, r, -sideUm / 2, -r / 2, sideUm / 2, -r / 2].map(Math.round), { closed: true });
};

/** 713: a cup — two sloping sides, elliptical rim, flat foot. 0.4 mm lines, round caps. */
const cup = (colour: string) => [
  stroke(colour, 400, [-1340, 1395, -820, -1380], { cap: "round" }),
  stroke(colour, 400, [1340, 1395, 820, -1380], { cap: "round" }),
  stroke(colour, 400, arcCoords(0, 1395, 1340, 375, 0, 360, 20), { closed: true, join: "round" }),
  stroke(colour, 400, [-820, -1380, -680, -1680, 680, -1680, 820, -1380], { cap: "round", join: "round" }),
];

export const course: LibraryEntryInput[] = [
  entry("701", "Start", "P", point(triangleOutline(PL, 350, 6000), "object"), { purpleRole: "lower", notes: "Triangle side 6.0 mm, 0.35 mm line; apex towards the first control." }),
  entry("702", "Map issue point", "P", point(stroke(PU, 600, [-1250, 0, 1250, 0]), "object"), { purpleRole: "upper", notes: "Bar 2.5 × 0.6 mm across the marked route." }),
  entry("703", "Control point", "P", point(ringCC(PL, 5000, 350)), { purpleRole: "lower", footprintM: 75, notes: "Circle ø 5.0 mm (CC), 0.35 mm." }),
  entry("704", "Control number", "T", { type: "text", fontFamily: "liberation-sans", fontSizeUm: 5600, digitHeightUm: 4000, colour: PU }, {
    purpleRole: "upper", notes: "Arial 4.0 mm digit height, non-bold; set with Liberation Sans. Upper purple by user decision 2026-10-24 (legibility; matches Mapper and Purple Pen) — a deliberate deviation from ISOM 2017-2 / 03 §2.4, which has it lower; ISSprOM has it upper.",
  }),
  entry("705", "Course line", "L", line({ main: solid(PL, 350) }), { purpleRole: "lower" }),
  entry("706", "Finish", "P", point([ringCC(PL, 4000, 350), ringCC(PL, 6000, 350)]), { purpleRole: "lower", notes: "Concentric circles ø 4.0 and 6.0 mm (CC), 0.35 mm." }),
  entry("707", "Marked route", "L", line({ main: dashed(PU, 350, 2000, 500) }), { purpleRole: "upper", minimum: { lengthUm: 4500 }, footprintM: 67.5, notes: "Dashes 2.0 / 0.5 mm, 0.35 mm." }),
  entry("708", "Out-of-bounds boundary", "L", line({ main: solid(PL, 700) }), { purpleRole: "lower", minimum: { lengthUm: 1000 }, footprintM: 15 }),

  entry("709", "Out-of-bounds area", "A", area({ hatches: [hatch(PU, 250, 1200, 45, { rotate: "never" })] }), {
    purpleRole: "upper", minimum: { widthUm: 3000, areaUm2: 9_000_000 }, footprintM: 45, notes: "Stripes 0.25 mm at 45°, 1.2 mm (CC) apart; no bounding line (no marking in the terrain).",
  }),
  entry("709", "Out-of-bounds area, solid boundary", "A", area({ hatches: [hatch(PU, 250, 1200, 45, { rotate: "never" })], border: { main: solid(PU, 200) } }), {
    purpleRole: "upper", variant: "b", description: "Boundary marked continuously in the terrain: 0.2 mm solid line.",
  }),
  entry("709", "Out-of-bounds area, dashed boundary", "A", area({ hatches: [hatch(PU, 250, 1200, 45, { rotate: "never" })], border: { main: dashed(PU, 200, 3000, 500) } }), {
    purpleRole: "upper", variant: "c", description: "Intermittent marking: 0.2 mm line dashed 3.0 / 0.5 mm.",
  }),

  entry(
    "710", "Crossing point", "L",
    line({
      borders: { left: border(PL, 350, 475), right: border(PL, 350, 475) },
      glyphs: [
        placed(glyph([stroke(PL, 350, [0, 475, -500, 775]), stroke(PL, 350, [0, -475, -500, -775])]), atStart),
        placed(glyph([stroke(PL, 350, [0, 475, 500, 775]), stroke(PL, 350, [0, -475, 500, -775])]), atEnd),
      ],
    }),
    { purpleRole: "lower", notes: "Two 0.35 mm lines 0.6 mm (inside measure) apart, curving outwards at both ends; the length follows the crossing. Flares drawn as straight 0.5 mm wings." },
  ),
  entry("711", "Out-of-bounds route", "L", line({ glyphs: [placed(glyph(cross(PU, 350, 1500), false), spaced(5000, { minCount: 2 }))] }), {
    purpleRole: "upper", minimum: { lengthUm: 6000 }, footprintM: 90, notes: "Crosses 3.0 mm, 0.35 mm, every 4–6 mm (CC); two crosses minimum.",
  }),
  entry("712", "First aid post", "P", point(plus(PL, 1330, 2000)), { purpleRole: "lower", notes: "Cross 4.0 × 4.0 mm, bars 1.33 mm." }),
  entry("713", "Refreshment point", "P", point(cup(PL)), { purpleRole: "lower", notes: "Cup 3.5 mm (outside measure) wide, 0.4 mm lines; shape after the spec drawing." }),
  entry("715", "Continuing point after map exchange", "P", point([ringCC(PL, 5000, 350), triangleOutline(PL, 350, 2600)], "object"), {
    purpleRole: "lower", notes: "Control circle ø 5.0 mm (CC) with a 0.35 mm triangle inside pointing towards the next control.",
  }),
];
