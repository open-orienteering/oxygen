/** ISOM 2017-2 Rev 6 — 1xx Landforms (brown). Dimensions µm at 1:15 000. */

import {
  arcCoords, area, atGapCentres, dashed, disc, fillPart, glyph, halfDisc, line, pattern, placed, point, solid, spaced, stroke, tick,
} from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, DASH_NOTE, entry } from "./common.js";

const B = C.brownLine;
const BP = C.brownPoint;

/** Slope line: 0.4 mm beyond the contour's edge, on the downhill (right) side. */
/** Slope line: angle 0 is north and the tick points to +y, downhill from the contour (OCAD 0,0 → 0,40; Mapper 0,0 → 0,−470 y-down; B10). */
const slopeLine = (widthUm: number, lengthUm: number) => point(tick(B, widthUm, 0, lengthUm + widthUm / 2), "object");

export const landforms: LibraryEntryInput[] = [
  entry("101", "Contour", "L", line({ main: solid(B, 140, { cap: "round", join: "round" }) })),
  entry("101", "Slope line, contour", "P", slopeLine(140, 400), { variant: "b", description: "Slope line drawn on the lower side of a contour." }),

  entry("102", "Index contour", "L", line({ main: solid(B, 250, { cap: "round", join: "round" }) })),
  entry("102", "Contour value", "T", { type: "text", fontFamily: "liberation-sans", fontSizeUm: 1500, colour: B }, {
    variant: "b", description: "Height value set into an index contour; top of the label on the higher side.",
    notes: "Spec: Arial 1.5 mm, non-bold. Rendered with Liberation Sans (metric-compatible).",
  }),

  entry("103", "Form line", "L", line({ main: dashed(B, 100, 2000, 200, { join: "round" }) }), { notes: DASH_NOTE }),
  entry("103", "Slope line, form line", "P", slopeLine(100, 400), { variant: "b", description: "Slope line on a form line." }),

  entry(
    "104", "Earth bank", "L",
    line({
      main: solid(B, 250),
      glyphs: [placed(glyph(tick(B, 140, 0, -525)), spaced(500, { firstUm: 70, lastUm: 70, minCount: 2 }))],
    }),
    {
      minimum: { lengthUm: 600 }, footprintM: 9,
      notes: "Top line 0.25 mm (Rev 6 change from 0.18). Tags 0.4 mm beyond the top line, 0.5 mm apart, the first and last 0.07 mm in from the ends (OCAD layout).",
    },
  ),
  entry("104", "Earth bank, top line", "L", line({ main: solid(B, 250) }), { variant: "b", description: "Top line without tags, for tag lines drawn as separate objects." }),
  entry("104", "Earth bank, tag line", "L", line({ main: solid(B, 140) }), { variant: "c", description: "A single tag drawn as its own line object (very high banks)." }),

  entry("105.1", "Earth wall", "L", line({ main: solid(B, 180, { join: "round" }), glyphs: [placed(glyph(disc(B, 450), false), spaced(2000, { minCount: 1 }))] }), {
    footprintM: 21, notes: "Dots ø 0.45 every 2.0 mm (CC), outside measure 0.77 mm.",
  }),
  entry("105.2", "Retaining earth wall", "L", line({ main: solid(B, 180), glyphs: [placed(glyph(halfDisc(B, 450)), spaced(1000, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1400 }, notes: "Half dots ø 0.45 every 1.0 mm (CC) on the lower side, outside measure 0.58 mm.",
  }),
  entry("106", "Ruined earth wall", "L", line({ main: dashed(B, 180, 2000, 350), glyphs: [placed(glyph(disc(B, 450), false), atGapCentres)] }), {
    notes: `Dots ø 0.45 in the gaps of a 2.0 / 0.35 dash. ${DASH_NOTE}`,
  }),
  entry("107", "Erosion gully", "L", line({ main: solid(B, 250, { cap: "pointed", join: "round", taper: { startUm: 750, endUm: 750 } }) }), {
    minimum: { lengthUm: 1150 }, notes: "Ends taper over 0.75 mm (pointed caps, `main.taper`, B10); minimum length 1.15 mm outside measure.",
  }),
  entry("108", "Small erosion gully", "L", line({ glyphs: [placed(glyph(disc(B, 250), false), spaced(450, { firstUm: 0, lastUm: 0, minCount: 2 }))] }), {
    minimum: { lengthUm: 1150 }, notes: "Dots ø 0.25 every 0.45 mm (CC); the main line has no stroke.",
  }),

  entry("109", "Small knoll", "P", point(disc(BP, 500)), { footprintM: 7.5 }),
  entry("110", "Small elongated knoll", "P", point(fillPart(BP, arcCoords(0, 0, 200, 400, 0, 360, 24)), "object"), { notes: "Ellipse 0.4 × 0.8 mm." }),
  entry(
    "111", "Small depression", "P",
    point(stroke(BP, 180, [310, 203, ...arcCoords(0, 32, 310, 139, 0, -180, 10), -310, 203]), "north"),
    { notes: "U shape 0.8 mm (outside measure) wide, 0.18 mm line, opening to the top; orientated to north (spec; B10, was turned with the object)." },
  ),
  entry("112", "Pit", "P", point(fillPart(BP, [154, 302, 350, 302, 0, -489, -350, 302, -154, 302, 0, -50]), "north"), {
    notes: "V shape 0.7 mm wide, arms 0.18 mm, apex downhill.",
  }),
  entry("113", "Broken ground", "A", area113(600)),
  entry("114", "Very broken ground", "A", area113(380)),
  entry("115", "Prominent landform feature", "P", point(stroke(BP, 180, [-294, -170, 294, -170, 0, 340], { closed: true }), "north"), {
    notes: "Triangle 0.6 mm wide, 0.18 mm line.",
  }),
];

/** 113 / 114: brown dots ø 0.2 on a regular grid of the spec's maximum spacing (03 §6.2: no irregular patterns). */
function area113(cellUm: number) {
  return area({ patterns: [pattern(glyph(disc(B, 200), false), cellUm)] });
}
