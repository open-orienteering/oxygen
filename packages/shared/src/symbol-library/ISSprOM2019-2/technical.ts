/** ISSprOM 2019-2 Rev 6 — 6xx Technical symbols. Dimensions µm at 1:4 000. */

import { line, solid } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { C, entry } from "./common.js";

export const technical: LibraryEntryInput[] = [
  entry("601", "Magnetic north line", "L", line({ main: solid(C.black, 140) }), { notes: "Black 0.14 mm; 30 mm apart at 1:4 000." }),
  entry("601", "Magnetic north line, blue", "L", line({ main: solid(C.blue, 180) }), { variant: "b", description: "Blue 0.18 mm where the map has few water features." }),
];
