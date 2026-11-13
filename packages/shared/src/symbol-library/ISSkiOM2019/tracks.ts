/**
 * ISSkiOM 2019 Revision 4 — §3.3.1 track symbols. Dimensions µm at
 * 1:15 000, from the text and its drawings only (docs/map-symbols.md §3,
 * §12.1).
 */

import { area, border, dashOcad, dashed, disc, doubleLine, glyph, hatch, line, placed, solid, spaced } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, DASH_NOTE, trackEntry as entry } from "./common.js";

const G = C.green;
const O = C.orange;
const K = C.black;
const W = C.mask;

/** "A white mask (0.15 mm on each side) is used under all green and orange track symbols." */
const MASK_UM = 150;
/** The mask as the main stroke's halo: `overallUm` + 0.15 each side, measured from the `coreUm` main stroke. */
const mask = (overallUm: number, coreUm: number, continuous = false) => ({
  colour: W,
  widthUm: (overallUm + 2 * MASK_UM - coreUm) / 2,
  ...(continuous ? { continuous: true } : {}),
});
/** "Black outline 0.12 mm (inside)" of a compulsory state whose overall width is `overallUm`. */
const EDGE_UM = 120;
const edges = (overallUm: number, dash?: ReturnType<typeof dashOcad>) => doubleLine(border(K, EDGE_UM, overallUm / 2 - EDGE_UM / 2, dash));

const MASK_NOTE = "White mask 0.15 mm on each side in white-skio (the main stroke's halo).";
const COMPULSORY_NOTE = "Orange core between black 0.12 mm edges inside the green state's overall width (Rev 4).";
const SLOW = "Dots every 1.3 mm (CC). The short line that starts a slow track at a junction is the mapper's drawing, not part of the symbol.";

const dots = (parts: Parameters<typeof glyph>[0]) => placed(glyph(parts, false), spaced(1300, { firstUm: 0, lastUm: 0, minCount: 2 }));

export const tracks: LibraryEntryInput[] = [
  entry("801.1", "Very wide track > 3.0 m", "L", line({ main: solid(G, 850, { halo: mask(850, 850) }) }), {
    notes: `Ski-O green 0.85 mm. ${MASK_NOTE}`,
  }),
  entry("801.2", "Very wide track > 3.0 m, compulsory to stay on", "L", line({ main: solid(O, 610, { halo: mask(850, 610) }), borders: edges(850) }), {
    notes: `Orange 0.61 mm, black edges 0.12 mm: 0.85 mm overall. ${COMPULSORY_NOTE} ${MASK_NOTE}`,
  }),
  entry("802.1", "Wide track 1.5 - 3.0 m", "L", line({ main: solid(G, 600, { halo: mask(600, 600) }) }), {
    notes: `Ski-O green 0.60 mm. ${MASK_NOTE}`,
  }),
  entry("802.2", "Wide track 1.5 - 3.0 m, compulsory to stay on", "L", line({ main: solid(O, 360, { halo: mask(600, 360) }), borders: edges(600) }), {
    notes: `Orange 0.36 mm, black edges 0.12 mm: 0.60 mm overall. ${COMPULSORY_NOTE} ${MASK_NOTE}`,
  }),
  entry("803.1", "Track 0.8 - 1.2 m", "L", line({ main: dashed(G, 500, 3000, 500, { halo: mask(500, 500, true) }) }), {
    notes: `Ski-O green 0.50 mm, dashes 3.0 mm, gaps 0.5 mm; the mask is continuous under the gaps (the drawing outlines the whole line). ${MASK_NOTE} ${DASH_NOTE}`,
  }),
  entry("803.2", "Track 0.8 - 1.2 m, compulsory to stay on", "L", line({ main: dashed(O, 260, 3000, 500, { halo: mask(500, 260, true) }), borders: edges(500, dashOcad(3000, 500)) }), {
    notes: `Orange 0.26 mm, black edges 0.12 mm (0.50 mm overall), dashed 3.0 / 0.5 mm together; continuous mask. ${COMPULSORY_NOTE} ${MASK_NOTE} ${DASH_NOTE}`,
  }),
  entry("804.1", "Track, slow 0.8 - 1.0 m", "L", line({ glyphs: [dots([disc(W, 1000), disc(G, 700)])] }), {
    notes: `Ski-O green dots ø 0.70 mm, each on a white-skio disc ø 1.0 mm (the mask; the drawing rings each dot). ${SLOW}`,
  }),
  entry("804.2", "Track, slow 0.8 - 1.0 m, compulsory to stay on", "L", line({ glyphs: [dots([disc(W, 1000), disc(K, 700), disc(O, 460)])] }), {
    notes: `Orange dots ø 0.46 mm in black ø 0.70 mm (the 0.12 mm black outline), each on a white-skio disc ø 1.0 mm. ${SLOW}`,
  }),
  entry("805", "Road covered with snow", "L", line({ main: solid(K, 700) }), {
    notes: "Black 0.70 mm: the road symbol, wider. No mask (black).",
  }),
  entry("807", "Unploughed road", "L", line({ borders: doubleLine(border(K, 120, 130, dashOcad(3000, 500))) }), {
    notes: `Two black 0.12 mm lines 0.14 mm apart (0.38 mm overall), dashed 3.0 / 0.5 mm together. ${DASH_NOTE}`,
  }),
  entry("808", "Prepared area", "A", area({
    hatches: [hatch(C.green100, 200, 800, 45, { rotate: "never" }), hatch(C.green100, 200, 800, -45, { rotate: "never" })],
    border: { main: solid(G, 130) },
  }), {
    notes: "Green 100 % cross-hatch (2023 erratum), lines 0.20 mm 0.80 mm (CC) apart at ±45°, fixed to north as drawn; Ski-O green outline 0.13 mm. green100-area is ticked for ISSkiOM by Oxygen (docs/map-symbols.md §12.3).",
  }),
  entry("813.1", "Public snow mobile route", "L", line({
    main: dashed(G, 570, 1500, 1000, { halo: mask(810, 570, true) }),
    borders: doubleLine(border(G, 120, 345)),
  }), {
    notes: `Ski-O green 0.81 mm: 0.12 mm edges and a 0.57 mm core dashed 1.5 mm green / 1.0 mm white — the white is the mask showing through the core's gaps. The "0.57" label marks the core, as 801.2's "0.61" does; the drawing is as wide as 813.2's. ${MASK_NOTE} ${DASH_NOTE}`,
  }),
  entry("813.2", "Public snow mobile route, compulsory to stay on", "L", line({
    main: dashed(O, 330, 1500, 1000, { halo: mask(810, 330, true) }),
    borders: { ...doubleLine(border(O, 120, 225)), extraPairs: [{ left: border(K, 120, 345), right: border(K, 120, 345) }] },
  }), {
    notes: `Black 0.12, orange 0.12, a 0.33 mm core dashed 1.5 mm orange / 1.0 mm white, orange 0.12, black 0.12: 0.81 mm overall, 813.1's width — Rev 4's black edges inside, the white core reduced from 0.57 to 0.33 mm. ${MASK_NOTE} ${DASH_NOTE}`,
  }),
];
