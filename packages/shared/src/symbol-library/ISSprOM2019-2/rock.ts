/** ISSprOM 2019-2 Rev 6 — 2xx Rock and boulders (black, grey). Dimensions µm at 1:4 000. */

import { area, disc, fillPart, glyph, line, pattern, placed, point, solid, spaced, tick, triangle } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, entry } from "./common.js";

const K = C.black;

/** Cliff tags: 0.18 mm, 0.75 mm beyond the line's edge, every 0.75 mm (CC), downhill (right) side. */
const cliffTags = (mainUm: number) => placed(glyph(tick(K, 180, 0, -(750 + mainUm / 2))), spaced(750, { firstUm: 90, lastUm: 90, minCount: 2 }));

export const rock: LibraryEntryInput[] = [
  entry("201", "Uncrossable cliff", "L", line({ main: solid(K, 500), glyphs: [cliffTags(500)] }), {
    minimum: { lengthUm: 750 }, notes: "0.5 mm line, tags 0.18 × 0.75 mm every 0.75 mm (CC).",
  }),
  entry("201", "Uncrossable cliff, top line", "L", line({ main: solid(K, 500) }), { variant: "b", description: "Top line without tags." }),
  entry("201", "Uncrossable cliff, tag line", "L", line({ main: solid(K, 180) }), { variant: "c", description: "A single tag as its own line object." }),
  entry("202", "Passable rock face", "L", line({ main: solid(K, 300, { cap: "round", join: "round" }) }), {
    minimum: { lengthUm: 1100 }, footprintM: 4.4, notes: "0.3 mm line without tags; round joins and ends as OCAD's ISSprOM set draws the tagless baseline (user decision 2026-10-24).",
  }),
  entry("202", "Passable rock face, with tags", "L", line({ main: solid(K, 300), glyphs: [cliffTags(300)] }), {
    variant: "b", description: "With 0.18 × 0.75 mm tags every 0.75 mm (CC) showing the direction of fall.", minimum: { lengthUm: 1100 },
  }),
  entry("203", "Rocky pit or cave", "P", point(fillPart(K, [-546, 409, -274, 409, 0, -217, 274, 409, 546, 409, 0, -841]), "north"), {
    footprintM: 4.4, notes: "Black V 1.1 × 1.25 mm (outside measure), arms 0.25 mm; north-oriented unless pointing into a cave.",
  }),
  entry("204", "Boulder", "P", point(disc(K, 600)), { footprintM: 2.4 }),
  entry("205", "Large boulder", "P", point(disc(K, 900)), { footprintM: 3.6 }),
  entry("206", "Gigantic boulder or rock pillar", "A", area({ fill: K }), { minimum: { widthUm: 300, areaUm2: 750_000 }, footprintM: 12 }),
  entry("207", "Boulder cluster", "P", point(triangle(K, 1200)), { footprintM: 4.8, notes: "Equilateral triangle, side 1.2 mm, apex north." }),
  entry("207", "Boulder cluster, large", "P", point(triangle(K, 1440)), { variant: "b", description: "Larger cluster, side 1.44 mm." }),
  entry("208", "Boulder field", "A", area({ patterns: [pattern(glyph(triangle(K, 960), false), 1500, { shiftedRows: true })] }), {
    notes: "Triangles side 0.96 mm on a shifted 1.5 mm grid (random placement in the spec, regular grid here per 03 §6.2).",
  }),
  entry("210", "Stony ground", "A", area({ patterns: [pattern(glyph(disc(K, 250), false), 600)] }), {
    notes: "Black dots ø 0.25 mm (Rev 6); 0.6 mm grid.",
  }),
  entry("213", "Open sandy ground", "A", area({ fill: C.yellow50, patterns: [pattern(glyph(disc(C.blackCultivated, 180), false), 500, { angleDeg: 45, rotate: "never" })] }), {
    minimum: { areaUm2: 1_000_000 }, notes: "Yellow 50 % with black dots ø 0.18 mm on a 0.5 mm grid at 45°.",
  }),
  entry("214", "Bare rock", "A", area({ fill: C.blackScreen }), { minimum: { areaUm2: 1_000_000 }, notes: "Black 35 % (Rev 6; 30 % before)." }),
];
