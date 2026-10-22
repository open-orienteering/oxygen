/** ISSprOM 2019-2 Rev 6 — 5xx Man-made features (black, brown). Dimensions µm at 1:4 000. */

import {
  arcCoords, area, atCorners, atDashCentres, atEnd, atStart, border, cross, dashOcad, dashed, disc, doubleLine, fillPart, glyph, hatch, line,
  pattern, placed, plus, point, ring, solid, spaced, square, stroke,
} from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, DASH_NOTE, entry } from "./common.js";

const K = C.black;
const KO = C.blackOutline;

/** Fence tag: 0.14 mm at 60°, 0.75 mm long, right-hand side. */
const fenceTag = glyph(stroke(K, 140, [0, 0, 375, -650]));
/** 528 / 529 chevron: 0.14 mm arms at 45°, 0.75 mm outside measure. */
const chevron = glyph([stroke(K, 140, [0, 0, -530, -530]), stroke(K, 140, [0, 0, -530, 530])]);
const scatteredPaved = (fill: string) =>
  area({ fill, patterns: [pattern(glyph(disc(C.whiteGB, 600), false), 750, { angleDeg: 45, rotate: "never" })] });
/** Paved area edge: 0.1 mm black, below the brown infill colours in the stack. */
const edge = solid(KO, 100);
/** 505 / 501 as a line of given width: brown band with 0.1 mm black edges (dashed for 505). */
const pavedLine = (widthUm: number, fill: string, dash?: ReturnType<typeof dashOcad>) =>
  line({ borders: doubleLine(border(KO, dash ? 120 : 100, widthUm / 2 + 50, dash), fill, widthUm) });
const stairs = (widthUm: number) =>
  line({
    main: { colour: C.brown30Paved, widthUm },
    borders: doubleLine(border(K, 100, widthUm / 2 + 50)),
    glyphs: [placed(glyph(stroke(K, 100, [0, -widthUm / 2, 0, widthUm / 2])), spaced(500, { minCount: 3 }))],
  });

export const manmade: LibraryEntryInput[] = [
  entry("501", "Paved area", "A", area({ fill: C.brown30Paved, border: { main: edge } }), {
    minimum: { widthUm: 350 }, notes: "Brown 30 % (light traffic) with a 0.1 mm black edge (501.1).",
  }),
  entry("501", "Paved area, heavy traffic", "A", area({ fill: C.brown50Paved, border: { main: edge } }), {
    variant: "b", description: "Brown 50 % for heavy traffic of vehicles or pedestrians.", minimum: { widthUm: 350 },
  }),
  entry("501", "Paved area, no edge line", "A", area({ fill: C.brown30Paved }), { variant: "c", description: "Light traffic without the black edge (indistinct transitions)." }),
  entry("501", "Paved area, heavy traffic, no edge line", "A", area({ fill: C.brown50Paved }), { variant: "d", description: "Heavy traffic without the black edge." }),
  entry("501", "Paved area, light traffic, as line", "L", pavedLine(350, C.brown30Road), {
    variant: "e", description: "Narrow paved way drawn as a line of its scaled width (authored at the 0.35 mm minimum).",
  }),
  entry("501", "Paved area, heavy traffic, as line", "L", pavedLine(350, C.brown50Road), { variant: "f", description: "As 501.e with brown 50 %." }),
  entry("501.1", "Step or edge of paved area", "L", line({ main: solid(KO, 100) })),
  entry("501.2", "Step or edge of paved area at lower level", "L", line({ main: { colour: KO, widthUm: 100, dash: dashOcad(700, 200), shortenStartUm: 150, shortenEndUm: 150 } }), {
    notes: `Dashes 0.7 / 0.2 mm, 0.1 mm, with a 0.15 mm cartographic gap at both ends. ${DASH_NOTE}`,
  }),
  entry("501.3", "Paved area with scattered trees", "A", scatteredPaved(C.brown30Paved), {
    minimum: { widthUm: 2200, areaUm2: 6_250_000 }, footprintM: 100, notes: "Brown 30 % with white holes ø 0.6 mm on a 0.75 mm grid at 45°.",
  }),
  entry("501.3", "Paved area with scattered trees, heavy traffic", "A", scatteredPaved(C.brown50Paved), { variant: "b", description: "Brown 50 % background." }),

  entry("505", "Unpaved footpath or track", "L", pavedLine(350, C.brown30Road, dashOcad(2000, 250)), {
    minimum: { widthUm: 350 }, notes: `Brown 30 % band of the way's scaled width (authored at the 0.35 mm minimum) with 0.12 mm black edges dashed 2.0 / 0.25 mm. ${DASH_NOTE}`,
  }),
  entry("506", "Small unpaved footpath or track", "L", line({ main: dashed(K, 270, 1500, 370) }), { minimum: { lengthUm: 3400 }, footprintM: 13.6, notes: DASH_NOTE }),
  entry("507", "Less distinct small path", "L", line({ main: dashed(K, 270, 3370, 1500, { dash: { secondaryGapUm: 370 } }) }), {
    minimum: { lengthUm: 7900 }, footprintM: 31.6, notes: `Double dashes 1.5 + 0.37 + 1.5 mm with 1.5 mm gaps. ${DASH_NOTE}`,
  }),
  entry("508", "Narrow ride", "L", line({ main: dashed(K, 210, 4500, 750) }), { minimum: { lengthUm: 9750 }, footprintM: 39, notes: DASH_NOTE }),
  entry(
    "509.1", "Railway", "L",
    line({ main: dashed(C.whiteRail, 250, 1000, 1500, { shortenStartUm: 1500, shortenEndUm: 1500 }), borders: { backgroundColour: K, backgroundWidthUm: 450 } }),
    { minimum: { lengthUm: 4000 }, footprintM: 16, notes: `White dashes 1.0 / 1.5 mm, 0.25 mm wide, over a black 0.45 mm band: the band's outer 0.1 mm either side are the rails (0.35 mm CC), the black between white dashes the 1.5 mm black dashes (OCAD's double-line fill; white-for-railway sorts above black, so the white is the dashed element). The white is shortened 1.5 mm at each open end so the line ends on a black dash (spec: minimum two black dashes); OCAD's sets end on a white dash. At a dash point or corner inside the line a white dash may meet the vertex where the spec drawing would show black (B10). ${DASH_NOTE}` },
  ),
  entry("509.2", "Tramway", "L", line({ borders: doubleLine(border(K, 80, 150)) }), { notes: "Two 0.08 mm black lines 0.3 mm (CC) apart (Rev 6: 0.08 mm, black 100 %)." }),
  entry("510", "Power line, cableway or ski lift", "L", line({ main: solid(K, 140), glyphs: [placed(glyph(stroke(K, 140, [0, -370, 0, 370])), atCorners())] }), {
    minimum: { lengthUm: 3750 }, footprintM: 15, notes: "Bars 0.14 mm reaching 0.3 mm beyond each edge of the line, at the pylons: corner points, on an end only when it is flagged (B10).",
  }),
  entry("511", "Major power line", "L", line({ borders: doubleLine(border(K, 140, 820)), glyphs: [placed(glyph(stroke(K, 200, [0, -1120, 0, 1120])), atCorners())] }), {
    notes: "Two 0.14 mm lines 1.5 mm apart inside; bars 0.2 mm reaching 0.3 mm beyond each line at the pylons.",
  }),
  entry(
    "511", "Major power line, with pylons", "L",
    line({ borders: doubleLine(border(K, 140, 820)), glyphs: [placed(glyph([stroke(K, 200, [0, -1120, 0, 1120]), stroke(K, 200, [-300, -300, 300, -300, 300, 300, -300, 300], { closed: true })]), atCorners())] }),
    { variant: "b", description: "Pylons as 0.8 × 0.8 mm (outside measure) squares." },
  ),
  entry(
    "512.1", "Bridge or tunnel entrance", "L",
    line({ main: solid(K, 400), glyphs: [placed(glyph(stroke(K, 400, [200, 0, 200, -400])), atStart), placed(glyph(stroke(K, 400, [-200, 0, -200, -400])), atEnd)] }),
    { notes: "One side of the bridge: 0.4 mm edge with 0.4 mm end bars turned towards the deck; 0.15 mm cartographic gap to adjoining black objects." },
  ),
  entry("512.2", "Underpass or tunnel", "L", line({ glyphs: [placed(glyph(square(K, 250), true), spaced(500, { firstUm: 325, lastUm: 325, minCount: 2 }))] }), {
    minimum: { lengthUm: 700 }, footprintM: 2.8, notes: "Black squares 0.25 mm every 0.5 mm (CC), 0.2 mm cartographic gap at both ends; two squares minimum.",
  }),
  entry("512.3", "Area runnable at lower level", "A", area({ hatches: [hatch(C.whiteTwoLevel, 600, 1200, 45)] }), {
    notes: "White stripes 0.6 mm at ≈45° to the structure's axis (object angle), 1.2 mm (CC) apart, over the lower-level symbols.",
  }),

  entry("513.1", "Passable wall", "L", line({ main: solid(K, 210), glyphs: [placed(glyph(disc(K, 600), false), spaced(3750, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1400 }, footprintM: 5.6, notes: "0.21 mm line, dots ø 0.6 mm every 3.75 mm (CC).",
  }),
  entry("513.2", "Passable retaining wall", "L", line({ main: solid(K, 210), glyphs: [placed(glyph(fillPart(K, arcCoords(0, 0, 300, 300, 180, 360, 10))), spaced(1900, { minCount: 1 }))] }), {
    minimum: { lengthUm: 1400 }, footprintM: 5.6, notes: "Half dots ø 0.6 mm every 1.9 mm (CC) on the lower side (Rev 6 graphic).",
  }),
  entry("515", "Uncrossable wall", "L", line({ main: solid(K, 400) }), { minimum: { lengthUm: 1000 }, footprintM: 4 }),
  entry("516", "Passable fence or railing", "L", line({ main: solid(K, 210), glyphs: [placed(fenceTag, spaced(3750, { minCount: 1 }))] }), {
    minimum: { lengthUm: 2200 }, footprintM: 8.8, notes: "0.21 mm line; tags 0.14 mm at 60°, 0.75 mm, every 3.75 mm (CC).",
  }),
  entry("518", "Uncrossable fence or railing", "L", line({ main: solid(K, 400), glyphs: [placed(fenceTag, spaced(3750, { perSpot: 2, spotSpacingUm: 900, minCount: 1 }))] }), {
    minimum: { lengthUm: 3000 }, footprintM: 12, notes: "0.4 mm line; pairs of tags 0.9 mm (CC) apart every 3.75 mm (CC).",
  }),
  entry("519", "Crossing point (optional)", "P", point([stroke(K, 250, [-625, -700, -625, 700]), stroke(K, 250, [625, -700, 625, 700])], "object"), {
    notes: "Two 0.25 mm bars 1.4 mm long, 1.0 mm (inside measure) apart.",
  }),
  entry("520", "Area that shall not be entered", "A", area({ fill: C.olive }), { minimum: { areaUm2: 1_000_000 }, notes: "Olive green." }),
  entry("520", "Area that shall not be entered, with boundary", "A", area({ fill: C.olive, border: { main: solid(KO, 100) } }), {
    variant: "b", description: "Clear border: 0.1 mm black boundary line.",
  }),
  entry("521", "Building", "A", area({ fill: C.black50, border: { main: solid(K, 140) } }), {
    minimum: { widthUm: 500, areaUm2: 250_000 }, footprintM: 4, notes: "Black 50 % with a 0.14 mm black outline.",
  }),
  entry("522", "Canopy", "A", area({ fill: C.black20, border: { main: solid(K, 100) } }), {
    minimum: { widthUm: 500, areaUm2: 250_000 }, footprintM: 4, notes: "Black 20 % with a 0.1 mm black outline.",
  }),
  entry("522", "Canopy, no outline", "A", area({ fill: C.black20 }), { variant: "b", description: "Outline omitted or drawn by other black lines." }),
  entry("522.1", "Pillar", "P", point(square(K, 500), "object"), { notes: "Black square, minimum 0.5 × 0.5 mm; larger pillars in plan shape." }),
  entry("524", "High tower", "P", point([disc(K, 1200), ...plus(K, 250, 1050)]), { footprintM: 8.4, notes: "Dot ø 1.2 mm with 0.25 mm arms, 2.1 mm overall." }),
  entry("525", "Small tower", "P", point([stroke(K, 220, [-750, 382, 750, 382]), stroke(K, 220, [0, 382, 0, -1118])]), { footprintM: 6, notes: "T shape 1.5 × 1.5 mm, 0.22 mm lines." }),
  entry("526", "Cairn, memorial, sculpture, small monument or boundary stone", "P", point([disc(K, 200), ring(K, 1000, 220)]), {
    footprintM: 4, notes: "Ring 1.0 mm outside measure, 0.22 mm, with a centre dot ø 0.2 mm.",
  }),
  entry("527", "Fodder rack", "P", point([stroke(K, 220, [-750, 48, 0, 481, 750, 48]), stroke(K, 220, [0, 481, 0, -1019])]), {
    footprintM: 6, notes: "Inverted Y, arms at 60°, 1.5 mm, 0.22 mm lines.",
  }),
  entry("528", "Prominent line feature", "L", line({ main: solid(K, 210), glyphs: [placed(chevron, spaced(3750, { minCount: 1 }))] }), {
    minimum: { lengthUm: 2200 }, footprintM: 8.8, notes: "0.21 mm line with 45° chevrons (0.75 mm) every 3.75 mm (CC).",
  }),
  entry("529", "Prominent uncrossable line feature", "L", line({ main: solid(K, 400), glyphs: [placed(chevron, spaced(3750, { perSpot: 2, spotSpacingUm: 900, minCount: 1 }))] }), {
    minimum: { lengthUm: 3000 }, footprintM: 12, notes: "0.4 mm line with pairs of chevrons 0.9 mm (CC) apart every 3.75 mm (CC).",
  }),
  entry("530", "Prominent man-made feature – ring", "P", point(ring(K, 1000, 220)), { footprintM: 4, notes: "Ring 1.0 mm outside measure, 0.22 mm." }),
  entry("531", "Prominent man-made feature – x", "P", point(cross(K, 220, 738)), { footprintM: 4.8, notes: "× 0.22 mm, 1.2 mm outside measure." }),
  entry("532", "Stairway", "L", stairs(400), {
    minimum: { widthUm: 400 }, notes: "0.1 mm black edges 0.4 mm (inside measure) apart on a brown 30 % band, 0.1 mm steps every 0.5 mm; three steps minimum. Width drawn to scale (authored at the minimum).",
  }),
  entry("533", "Area with obstacles", "A", area({ patterns: [pattern(glyph(disc(C.black50, 550), false), 750, { angleDeg: 45, rotate: "never" })] }), {
    minimum: { areaUm2: 4_060_000 }, footprintM: 65, notes: "Rev 6 addition: black 50 % dots ø 0.55 mm on a 0.75 mm grid at 45°.",
  }),
];
