/**
 * ISSkiOM 2019 Revision 4 — §3.3.2 other symbols: the ski versions of
 * water and marsh (docs/map-symbols.md §12.1). Dimensions µm at 1:15 000.
 * 515 *Impassable wall (barrier)* is ISOM 2017-2's 515 and is not here.
 */

import { area, glyph, pattern, solid, stroke } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, EDITION, otherEntry as entry } from "./common.js";

export const water: LibraryEntryInput[] = [
  entry("301.1", "Crossable body of water", "A", area({ fill: C.blue50, border: { main: solid(C.blueLine, 100) } }), {
    notes: "Blue 50 % with a 0.1 mm blue bank line, as ISOM 2017-2 Shallow body of water (302).",
  }),
  entry("301.2", "Body of water that shall not be crossed", "A", area({ fill: C.blueArea, border: { main: solid(C.black, 300) } }), {
    notes: "Blue 100 % with a 0.3 mm black bank line.",
  }),
  entry(
    "310.1", "Marsh (in ski orienteering map)", "A",
    area({ patterns: [pattern(glyph(stroke(C.blue50, 100, [-450, 0, 450, 0]), false), { w: 1150, h: 300 }, { shiftedRows: true, rotate: "never" })] }),
    {
      notes: "\"The same symbol as Indistinct marsh (310)\" in blue 50 %: ISOM 2017-2 310's dashes 0.9 × 0.1 mm, gap 0.25 mm, rows 0.3 mm (CC) apart, alternate rows shifted; orientated to north.",
      source: `${EDITION}, §3.3.2, symbol 310.1; dimensions ISOM 2017-2 Rev 6 (IOF Map Commission, 2024), symbol 310`,
    },
  ),
];
