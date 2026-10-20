/** ISOM 2017-2 Rev 6 — 6xx Technical symbols. Dimensions µm at 1:15 000. */

import { disc, line, plus, point, solid } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, entry } from "./common.js";

export const technical: LibraryEntryInput[] = [
  entry("601", "Magnetic north line", "L", line({ main: solid(C.black, 100) }), { notes: "Black 0.1 mm; 20 mm apart at 1:15 000 (30 mm when enlarged to 1:10 000)." }),
  entry("601", "Magnetic north line, blue", "L", line({ main: solid(C.blueLine, 120) }), { variant: "b", description: "Blue 0.12 mm where the map has few water features." }),
  entry("602", "Registration mark", "P", point(plus(C.black, 100, 2000)), { notes: "Cross of 0.1 mm lines, 4 mm minimum; printed in every colour — black stands in for the set." }),
  entry("603", "Spot height", "P", point(disc(C.black, 300)), { notes: "Dot ø 0.3 mm; water levels are given without the dot." }),
  entry("603", "Spot height, value", "T", { type: "text", fontFamily: "liberation-sans", fontSizeUm: 1500, colour: C.black }, {
    variant: "b", description: "Height to the nearest metre, sans-serif 1.5 mm.",
  }),
];
