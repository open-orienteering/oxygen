/** ISSprOM 2019-2 Rev 6 — 1xx Landforms (brown). Dimensions µm at 1:4 000. */

import { arcCoords, area, dashed, disc, fillPart, glyph, halfDisc, line, pattern, placed, point, solid, spaced, stroke, tick } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, DASH_NOTE, entry } from "./common.js";

const B = C.brown;

const slopeLine = (widthUm: number, omUm: number) => point(tick(B, widthUm, 0, -(omUm - widthUm / 2)), "object");

/** Earth bank tags: 0.21 mm, 0.75 mm beyond the top line's edge, 0.75 mm (CC) apart. */
const bankTags = (mainUm: number) => placed(glyph(tick(B, 210, 0, -(750 + mainUm / 2))), spaced(750, { firstUm: 100, lastUm: 100, minCount: 2 }));

export const landforms: LibraryEntryInput[] = [
  entry("101", "Contour", "L", line({ main: solid(B, 210, { cap: "round", join: "round" }) })),
  entry("101", "Slope line, contour", "P", slopeLine(210, 750), { variant: "b", description: "Slope line, 0.75 mm outside measure, on the lower side." }),
  entry("102", "Index contour", "L", line({ main: solid(B, 300, { cap: "round", join: "round" }) })),
  entry("102", "Contour value", "T", { type: "text", fontFamily: "liberation-sans", fontSizeUm: 1520, colour: B }, {
    variant: "b", description: "Height value in an index contour, 1.52 mm (6 pt).",
  }),
  entry("103", "Form line", "L", line({ main: dashed(B, 150, 3000, 300, { join: "round" }) }), { notes: DASH_NOTE }),
  entry("103", "Slope line, form line", "P", slopeLine(150, 600), { variant: "b", description: "Slope line on a form line, 0.6 mm outside measure." }),

  entry("104", "Earth bank", "L", line({ main: solid(B, 270), glyphs: [bankTags(270)] }), {
    minimum: { lengthUm: 750 }, notes: "Top line 0.27 mm; tags 0.21 mm, 0.75 mm long, every 0.75 mm (CC).",
  }),
  entry("104", "Earth bank, very high", "L", line({ main: solid(B, 370), glyphs: [bankTags(370)] }), {
    variant: "b", description: "Very high earth bank: 0.37 mm top line.", minimum: { lengthUm: 750 },
  }),
  entry("104", "Earth bank, top line", "L", line({ main: solid(B, 270) }), { variant: "c", description: "Top line without tags." }),
  entry("104", "Earth bank, tag line", "L", line({ main: solid(B, 210) }), { variant: "d", description: "A single tag as its own line object." }),

  entry("105.1", "Small earth wall", "L", line({ main: solid(B, 270, { join: "round" }), glyphs: [placed(glyph(disc(B, 700), false), spaced(3750, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1400 }, footprintM: 5.6, notes: "0.27 mm line (Rev 6; 0.18 before), dots ø 0.7 mm every 3.75 mm (CC).",
  }),
  entry("105.2", "Retaining earth wall seen only from one side", "L", line({ main: solid(B, 270), glyphs: [placed(glyph(halfDisc(B, 700)), spaced(1900, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1400 }, footprintM: 5.6, notes: "Rev 6 addition: half dots ø 0.7 mm every 1.9 mm (CC) on the lower side.",
  }),
  entry("107", "Erosion gully", "L", line({ main: solid(B, 370, { cap: "pointed", join: "round" }) }), {
    minimum: { lengthUm: 2000 }, footprintM: 8, notes: "0.37 mm, ends tapering over 0.75 mm.",
  }),
  entry("108", "Small erosion gully", "L", line({ glyphs: [placed(glyph(disc(B, 370), false), spaced(600, { firstUm: 0, lastUm: 0, minCount: 2 }))] }), {
    minimum: { lengthUm: 1000 }, footprintM: 4, notes: "Dots ø 0.37 mm every 0.6 mm (CC); two dots minimum.",
  }),
  entry("109", "Small knoll", "P", point(disc(B, 750)), { footprintM: 3 }),
  entry("110", "Small elongated knoll", "P", point(fillPart(B, arcCoords(0, 0, 300, 600, 0, 360, 24)), "object"), { notes: "Ellipse 0.6 × 1.2 mm." }),
  entry("111", "Small depression", "P", point(stroke(B, 250, [475, 135, 475, -127, ...arcCoords(0, -127, 475, 213, 0, -180, 10), -475, 135]), "object"), {
    notes: "U shape 1.2 × 0.6 mm (outside measure), 0.25 mm line.",
  }),
  entry("112", "Pit or hole", "P", point(fillPart(B, [-546, 409, -274, 409, 0, -217, 274, 409, 546, 409, 0, -841]), "object"), {
    footprintM: 4.4, notes: "V shape 1.1 × 1.25 mm (outside measure), arms 0.25 mm.",
  }),
  entry("113", "Broken ground", "A", area({ patterns: [pattern(glyph(disc(B, 300), false), 700)] }), {
    notes: "Brown dots ø 0.3 mm (Rev 6); the spec gives no spacing — 0.7 mm grid chosen to match drawn examples.",
  }),
  entry("115", "Prominent landform feature", "P", point(stroke(B, 250, [-373, -215, 373, -215, 0, 431], { closed: true }), "north"), {
    footprintM: 5.4, notes: "Triangle 1.35 mm wide, 0.25 mm line.",
  }),
];
