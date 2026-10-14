/**
 * The pilot symbol family of spike S1 (04 §9, 09 §7): enough of ISOM to
 * exercise every rule of the stage. Dimensions are ISOM-like µm at
 * 1:15 000 but not the canonical library — that is slice B's
 * `map-symbols.md`. Colour indices refer to `pilotColours`.
 */

import { type RenderSymbol, parseRenderSymbol } from "../symbol.js";

export const pilotColours: { name: string; hex: string }[] = [
  { name: "white", hex: "#ffffff" },           // 0
  { name: "yellow 50 %", hex: "#ffdc9a" },     // 1
  { name: "white over yellow (407 dots)", hex: "#ffffff" }, // 2 — a knock-out white placed just above yellow, as ISOM sets do
  { name: "green 50 %", hex: "#9dd9a5" },      // 3
  { name: "green 100 %", hex: "#3cb54a" },     // 4
  { name: "brown 50 % (framing)", hex: "#e8ad80" }, // 5
  { name: "brown", hex: "#d15c00" },           // 6
  { name: "blue", hex: "#00a3e0" },            // 7
  { name: "black", hex: "#000000" },           // 8
  { name: "purple lower", hex: "#c800c8" },    // 9
  { name: "upper white", hex: "#ffffff" },     // 10
  { name: "purple upper", hex: "#c800c8" },    // 11
];

export const PILOT = {
  contour101: 0,
  footpath505: 1,
  footpathOmap505: 2,
  wideRoad502: 3,
  roadFramed503: 4,
  powerLine516: 5,
  tree418: 6,
  roughOpen403: 7,
  scatteredTrees407: 8,
  sandyGround213: 9,
  outOfBounds709: 10,
  crossed714: 11,
  controlNumber704: 12,
  wall529: 13,
} as const;

const defs: unknown[] = [
  // 0 — 101 contour: solid brown stroke, round caps and joins.
  { type: "line", id: "pilot:101", code: "101", name: "Contour", main: { colour: 6, widthUm: 140, cap: "round", join: "round" } },
  // 1 — 505 footpath, OCAD dash fitting.
  { type: "line", id: "pilot:505", code: "505", name: "Footpath", main: { colour: 8, widthUm: 250, dash: { layout: "ocad", dashUm: 2000, gapUm: 500 } } },
  // 2 — the same footpath with OMAP fitting and half outer dashes.
  { type: "line", id: "pilot:505omap", code: "505", name: "Footpath (OMAP)", main: { colour: 8, widthUm: 250, dash: { layout: "omap", dashUm: 2000, gapUm: 500, halfOuterDashes: true } } },
  // 3 — 502 wide road: two black edges on a brown-50 infill, no main line.
  {
    type: "line", id: "pilot:502", code: "502", name: "Wide road",
    borders: { left: { colour: 8, widthUm: 140, shiftUm: 350 }, right: { colour: 8, widthUm: 140, shiftUm: 350 }, backgroundColour: 5 },
  },
  // 4 — 503 road with a framing halo in a lower colour (the club-set 502 band).
  { type: "line", id: "pilot:503", code: "503", name: "Road (framed)", main: { colour: 8, widthUm: 350, halo: { colour: 5, widthUm: 200 } } },
  // 5 — 516 power line: solid line, crossbars at the (zero-width) gaps of a virtual dash layout.
  {
    type: "line", id: "pilot:516", code: "516", name: "Power line",
    main: { colour: 8, widthUm: 140, dash: { layout: "ocad", dashUm: 7000, gapUm: 0, endDashUm: 3500 } },
    glyphs: [{ glyph: { rotatable: true, parts: [{ kind: "stroke", colour: 8, widthUm: 140, geometry: { coords: [0, -350, 0, 350] } }] }, placement: { at: "gapCentres" } }],
  },
  // 6 — 418 prominent tree: green disc under a black ring, north-up.
  {
    type: "point", id: "pilot:418", code: "418", name: "Prominent tree", orientation: "north",
    glyph: { rotatable: false, parts: [{ kind: "disc", colour: 4, diameterUm: 600 }, { kind: "ring", colour: 8, diameterUm: 1200, widthUm: 140 }] },
  },
  // 7 — 403 rough open land: plain fill.
  { type: "area", id: "pilot:403", code: "403", name: "Rough open land", fill: 1 },
  // 8 — 407 rough open land with scattered trees: fill + white dot grid, shifted rows, centre-inside.
  {
    type: "area", id: "pilot:407", code: "407", name: "Rough open land with scattered trees", fill: 1,
    patterns: [{ glyph: { rotatable: false, parts: [{ kind: "disc", colour: 2, diameterUm: 400 }] }, cellWidthUm: 1000, cellHeightUm: 1000, offsetXUm: 500, offsetYUm: 500, shiftedRows: true, clip: "centreInside" }],
  },
  // 9 — 213 sandy ground: yellow fill + black dots in clip mode.
  {
    type: "area", id: "pilot:213", code: "213", name: "Sandy ground", fill: 1,
    patterns: [{ glyph: { rotatable: false, parts: [{ kind: "disc", colour: 8, diameterUm: 300 }] }, cellWidthUm: 800, cellHeightUm: 800, clip: "clip" }],
  },
  // 10 — 709 out-of-bounds: vertical purple stripes, no fill.
  { type: "area", id: "pilot:709", code: "709", name: "Out-of-bounds area", hatches: [{ colour: 9, widthUm: 250, spacingUm: 1000, angleDeg: 90 }] },
  // 11 — 714 (crossed stripes): two hatch directions.
  {
    type: "area", id: "pilot:714", code: "714", name: "Temporary construction", fill: 1,
    hatches: [{ colour: 8, widthUm: 180, spacingUm: 1200, angleDeg: 45 }, { colour: 8, widthUm: 180, spacingUm: 1200, angleDeg: 135 }],
  },
  // 12 — 704 control number: 4.0 mm digit height, upper purple with an upper-white halo.
  { type: "text", id: "pilot:704", code: "704", name: "Control number", fontFamily: "liberation-sans", fontSizeUm: 5000, digitHeightUm: 4000, colour: 11, halo: { colour: 10, widthUm: 150 } },
  // 13 — 529 wall-like line: solid main, square corner glyphs with mitre scaling, spaced ticks.
  {
    type: "line", id: "pilot:529", code: "529", name: "Wall",
    main: { colour: 8, widthUm: 140 },
    glyphs: [
      { glyph: { rotatable: true, parts: [{ kind: "fill", colour: 8, geometry: { coords: [-150, -150, 150, -150, 150, 150, -150, 150], closed: true } }] }, placement: { at: "corners", ignoreEnds: true }, scaleAtCorners: true },
      { glyph: { rotatable: true, parts: [{ kind: "stroke", colour: 8, widthUm: 140, geometry: { coords: [0, 0, 0, 300] } }] }, placement: { at: "spaced", distanceUm: 1000, firstUm: 500, lastUm: 500 } },
    ],
  },
];

export const pilotSymbols: RenderSymbol[] = defs.map(parseRenderSymbol);
