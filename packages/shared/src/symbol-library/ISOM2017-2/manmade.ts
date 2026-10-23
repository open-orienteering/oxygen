/** ISOM 2017-2 Rev 6 — 5xx Man-made features (black, brown). Dimensions µm at 1:15 000. */

import {
  arcCoords, area, atCorners, atDashCentres, atEnd, atStart, border, cross, dashOcad, dashed, disc, doubleLine, fillPart, glyph, line, placed, plus,
  point, ring, solid, spaced, stroke,
} from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, DASH_NOTE, entry } from "./common.js";

const K = C.black;
const KO = C.blackOutline;

/** Fence tag: 0.14 mm, leaving the line at 60°, 0.4 mm outside measure, on the right-hand side. */
const fenceTag = glyph(stroke(K, 140, [0, 0, 200, -346]));
/** 528 / 529 chevron: two 0.14 mm arms at 45°, 0.4 mm outside measure, pointing along the line. */
const chevron = glyph([stroke(K, 140, [0, 0, -330, -330]), stroke(K, 140, [0, 0, -330, 330])]);
/** 508: the main black dashes over a continuous runnability band 0.45 mm wide. */
const ride = (bandColour?: string) =>
  line({ main: { colour: K, widthUm: 140, dash: dashOcad(2000, 250), ...(bandColour ? { halo: { colour: bandColour, widthUm: 155, continuous: true } } : {}) } });

export const manmade: LibraryEntryInput[] = [
  entry("501", "Paved area", "A", area({ fill: C.brownPaved, border: { main: solid(KO, 100) } }), {
    minimum: { areaUm2: 1_000_000 }, footprintM: 15, notes: "Brown 50 % with a 0.1 mm black edge.",
  }),
  entry("501", "Paved area, no edge line", "A", area({ fill: C.brownPaved }), { variant: "b", description: "Edge drawn by another black line symbol or omitted." }),

  entry("502", "Wide road", "L", line({ borders: doubleLine(border(KO, 140, 220), C.brownRoad) }), {
    minimum: { widthUm: 580 }, footprintM: 8.7, notes: "Two 0.14 mm black edges, minimum 0.3 mm apart inside, brown 50 % infill; width drawn to scale (object width).",
  }),
  entry("503", "Road", "L", line({ main: solid(K, 350) })),
  entry("504", "Vehicle track", "L", line({ main: dashed(K, 350, 3000, 250) }), { minimum: { lengthUm: 6250 }, footprintM: 94, notes: DASH_NOTE }),
  entry("505", "Footpath", "L", line({ main: dashed(K, 250, 2000, 250) }), { minimum: { lengthUm: 4250 }, footprintM: 64, notes: DASH_NOTE }),
  entry("506", "Small footpath", "L", line({ main: dashed(K, 180, 1000, 250) }), { minimum: { lengthUm: 2250 }, footprintM: 34, notes: DASH_NOTE }),
  entry("507", "Less distinct small footpath", "L", line({ main: dashed(K, 180, 2250, 800, { dash: { secondaryGapUm: 250 } }) }), {
    minimum: { lengthUm: 5300 }, footprintM: 79.5, notes: `Double dashes 1.0 + 0.25 + 1.0 mm with 0.8 mm gaps (OCAD main 2.25 / gap 0.8 / secondary gap 0.25). ${DASH_NOTE}`,
  }),

  entry("508", "Narrow ride or linear trace through the terrain", "L", ride(), { minimum: { lengthUm: 3250 }, footprintM: 48, notes: `Black dashes 2.0 / 0.25 mm, 0.14 mm; no runnability band. ${DASH_NOTE}` }),
  entry("508", "Narrow ride, easy running", "L", ride(C.yellow), { variant: "b", description: "Yellow 100 % band 0.45 mm under the dashes." }),
  entry("508", "Narrow ride, normal runnability", "L", ride(C.whiteGB), { variant: "c", description: "White band 0.45 mm under the dashes (in green)." }),
  entry("508", "Narrow ride, slow running", "L", ride(C.green30), { variant: "d", description: "Green 30 % band 0.45 mm under the dashes." }),
  entry("508", "Narrow ride, walk", "L", ride(C.green60), { variant: "e", description: "Green 60 % band 0.45 mm under the dashes." }),

  entry(
    "509", "Railway", "L",
    line({
      main: dashed(C.whiteRail, 250, 1000, 1500, { shortenStartUm: 1500, shortenEndUm: 1500 }),
      borders: { backgroundColour: K, backgroundWidthUm: 450 },
    }),
    { minimum: { lengthUm: 4000 }, footprintM: 60, notes: `White dashes 1.0 / 1.5 mm, 0.25 mm wide, over a black 0.45 mm band: the band's outer 0.1 mm either side are the rails (0.35 mm CC), the black between white dashes the 1.5 mm black dashes (OCAD's double-line fill; white-for-railway sorts above black, so the white is the dashed element). The white is shortened 1.5 mm at each open end so the line ends on a black dash (spec: minimum two black dashes); OCAD's sets end on a white dash. At a dash point or corner inside the line a white dash may meet the vertex where the spec drawing would show black (B10). ${DASH_NOTE}` },
  ),

  entry("510", "Power line, cableway or skilift", "L", line({ main: solid(K, 140), glyphs: [placed(glyph(stroke(K, 140, [0, -370, 0, 370])), atCorners())] }), {
    notes: "Bars 0.14 mm reaching 0.3 mm beyond each edge of the line (0.74 mm long), at the pylons: corner points set by the mapper, on an end only when it is flagged (OCAD corner symbol, Mapper dash symbol; B10).",
  }),
  entry("511", "Major power line", "L", line({ borders: doubleLine(border(K, 140, 200)), glyphs: [placed(glyph(stroke(K, 200, [0, -570, 0, 570])), atCorners())] }), {
    notes: "Two 0.14 mm lines 0.4 mm (CC) apart (minimum; drawn to scale); bars 0.2 mm reaching 0.3 mm beyond each line at the pylons (corner points, as 510).",
  }),
  entry(
    "511", "Major power line, with pylons", "L",
    line({
      borders: doubleLine(border(K, 140, 200)),
      glyphs: [placed(glyph([stroke(K, 200, [0, -570, 0, 570]), stroke(K, 200, [-300, -300, 300, -300, 300, 300, -300, 300], { closed: true })]), atCorners())],
    }),
    { variant: "b", description: "Pylons shown as 0.8 × 0.8 mm (outside measure) squares, 0.2 mm line." },
  ),

  entry(
    "512", "Bridge / tunnel", "L",
    line({
      main: solid(K, 180),
      glyphs: [
        placed(glyph([stroke(K, 180, [0, 0, -250, 433]), stroke(K, 180, [0, 0, -250, -433])]), atStart),
        placed(glyph([stroke(K, 180, [0, 0, 250, 433]), stroke(K, 180, [0, 0, 250, -433])]), atEnd),
      ],
    }),
    { minimum: { lengthUm: 400 }, footprintM: 6, notes: "Baseline 0.18 mm; wings 0.5 mm (outside measure) at 60° to the baseline at both ends." },
  ),
  entry("512", "Bridge / tunnel, one side", "L", line({ main: solid(K, 180), glyphs: [placed(glyph(stroke(K, 180, [0, 0, -250, 433])), atStart), placed(glyph(stroke(K, 180, [0, 0, 250, 433])), atEnd)] }), {
    variant: "b", description: "One side of a wide bridge or tunnel entrance: baseline with wings on the left only.",
  }),

  entry("513.1", "Wall", "L", line({ main: solid(K, 140), glyphs: [placed(glyph(disc(K, 400), false), spaced(2000, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1400 }, footprintM: 21, notes: "0.14 mm line, dots ø 0.4 mm every 2.0 mm (CC).",
  }),
  entry("513.2", "Retaining wall", "L", line({ main: solid(K, 140), glyphs: [placed(glyph(fillPart(K, arcCoords(0, -50, 200, 200, 180, 360, 10))), spaced(1000, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1400 }, footprintM: 21, notes: "Half dots ø 0.4 mm every 1.0 mm (CC) on the lower side, shifted 0.05 mm off the centre line (Rev 6).",
  }),
  entry("514", "Ruined wall", "L", line({ main: dashed(K, 140, 2000, 350), glyphs: [placed(glyph(disc(K, 400), false), atDashCentres)] }), {
    minimum: { lengthUm: 3650 }, footprintM: 55, notes: `Dashes 2.0 / 0.35 mm with a dot ø 0.4 mm on each dash. ${DASH_NOTE}`,
  }),
  entry("515", "Impassable wall", "L", line({ main: solid(K, 250), glyphs: [placed(glyph(disc(K, 600), false), spaced(3000, { perSpot: 2, spotSpacingUm: 800, minCount: 1 }))] }), {
    minimum: { lengthUm: 3000 }, footprintM: 45, notes: "0.25 mm line; pairs of dots ø 0.6 mm, 0.8 mm (CC) apart, every 3.0 mm (CC).",
  }),
  entry("516", "Fence", "L", line({ main: solid(K, 140), glyphs: [placed(fenceTag, spaced(2000, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1500 }, footprintM: 22.5, notes: "0.14 mm line; tags at 60°, 0.4 mm outside measure, every 2.0 mm (CC).",
  }),
  entry("517", "Ruined fence", "L", line({ main: dashed(K, 140, 2000, 350), glyphs: [placed(fenceTag, atDashCentres)] }), {
    minimum: { lengthUm: 3650 }, footprintM: 55, notes: `Dashes 2.0 / 0.35 mm with one tag per dash. ${DASH_NOTE}`,
  }),
  entry("518", "Impassable fence", "L", line({ main: solid(K, 250), glyphs: [placed(fenceTag, spaced(2500, { perSpot: 2, spotSpacingUm: 600, minCount: 1 }))] }), {
    minimum: { lengthUm: 2000 }, footprintM: 30, notes: "0.25 mm line; pairs of tags 0.6 mm (CC) apart every 2.5 mm (CC).",
  }),
  entry("519", "Crossing point", "P", point([stroke(K, 180, [-300, -500, -300, 500]), stroke(K, 180, [300, -500, 300, 500])], "object"), {
    notes: "Two 0.18 mm bars 1.0 mm long, 0.6 mm (CC) apart, across the fence or wall.",
  }),

  entry("520", "Area that shall not be entered", "A", area({ fill: C.olive }), { minimum: { areaUm2: 1_000_000 }, footprintM: 15, notes: "Olive green (yellow 100 % + green 50 %)." }),
  entry("520", "Area that shall not be entered, with boundary", "A", area({ fill: C.olive, border: { main: solid(K, 180) } }), {
    variant: "b", description: "Clear border: 0.18 mm black boundary line.",
  }),
  entry("521", "Building", "A", area({ fill: K }), { minimum: { areaUm2: 250_000 }, footprintM: 7.5, notes: "Black; passages through buildings at least 0.4 mm wide." }),
  entry("521", "Building, large", "A", area({ fill: C.black50, border: { main: solid(K, 200) } }), {
    variant: "b", description: "Buildings larger than 75 × 75 m in urban areas: black 50 % with a 0.2 mm black outline.",
  }),
  entry("522", "Canopy", "A", area({ fill: C.black20, border: { main: solid(K, 100) } }), {
    minimum: { widthUm: 400, areaUm2: 360_000 }, footprintM: 9, notes: "Black 20 % with a 0.1 mm black outline.",
  }),
  entry("522", "Canopy, no outline", "A", area({ fill: C.black20 }), { variant: "b", description: "Outline drawn by other black lines or omitted." }),
  entry("523", "Ruin", "L", line({ main: dashed(K, 160, 500, 250) }), {
    minimum: { areaUm2: 640_000 }, footprintM: 12, notes: `Dashed outline 0.5 / 0.25 mm, 0.16 mm; minimum 0.8 × 0.8 mm outside measure. ${DASH_NOTE}`,
  }),
  entry("524", "High tower", "P", point([disc(K, 800), ...plus(K, 160, 700)]), { notes: "Dot ø 0.8 mm with 0.16 mm arms reaching 0.3 mm beyond it." }),
  entry("525", "Small tower", "P", point([stroke(K, 160, [-500, 308, 500, 308]), stroke(K, 160, [0, 308, 0, -602])]), { notes: "T shape 1.0 × 1.0 mm outside measure, 0.16 mm lines." }),
  entry("526", "Cairn", "P", point([disc(K, 140), ring(K, 800, 160)]), { notes: "Ring 0.8 mm outside measure, 0.16 mm, with a centre dot ø 0.14 mm." }),
  entry("527", "Fodder rack", "P", point([stroke(K, 160, [-410, 37, 0, 274, 410, 37]), stroke(K, 160, [0, 274, 0, -546])]), {
    notes: "Inverted Y, arms at 60°, 0.9 mm outside measure, 0.16 mm lines.",
  }),
  entry("528", "Prominent line feature", "L", line({ main: solid(K, 140), glyphs: [placed(chevron, spaced(2000, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1500 }, footprintM: 22.5, notes: "0.14 mm line with 45° chevrons (0.4 mm outside measure) every 2.0 mm (CC).",
  }),
  entry("529", "Prominent uncrossable line feature", "L", line({ main: solid(K, 250), glyphs: [placed(chevron, spaced(2000, { perSpot: 2, spotSpacingUm: 600, minCount: 1 }))] }), {
    minimum: { lengthUm: 2000 }, footprintM: 30, notes: "0.25 mm line with pairs of chevrons 0.6 mm (CC) apart every 2.0 mm (CC).",
  }),
  entry("530", "Prominent man-made feature – ring", "P", point(ring(K, 800, 160)), { notes: "Ring 0.8 mm outside measure, 0.16 mm." }),
  entry("531", "Prominent man-made feature – x", "P", point(cross(K, 160, 486)), { notes: "× 0.16 mm, 0.8 mm outside measure." }),
  entry(
    "532", "Stairway", "L",
    line({
      main: { colour: C.whiteGB, widthUm: 400 },
      borders: doubleLine(border(K, 100, 250)),
      glyphs: [placed(glyph(stroke(K, 100, [0, -200, 0, 200])), spaced(500, { minCount: 3 }))],
    }),
    { minimum: { widthUm: 400 }, notes: "0.1 mm black edges 0.4 mm (inside measure) apart on a white band, 0.1 mm steps every 0.5 mm; three steps minimum. Width drawn to scale." },
  ),
];
