/**
 * ISSkiOM 2019 Revision 4 — an overlay library: the ski-only symbols, offered
 * on any document beside its own library (docs/map-symbols.md §12).
 * Reference scale 1:15 000.
 */

import { withNamesAndAliases } from "../authoring.js";
import type { LibraryEntryInput } from "../schema.js";
import { LIBRARY_ID } from "./common.js";
import { ALIASES, SV } from "./names.js";
import { tracks } from "./tracks.js";
import { water } from "./water.js";

export const isskiom2019 = {
  id: LIBRARY_ID,
  spec: "ISSkiOM2019" as const,
  revision: "Revision 4 (September 2026)",
  referenceScale: 15_000,
  palette: "iof2024" as const,
  kind: "overlay" as const,
  /** ISSkiOM §3.2, factors as printed (docs/map-symbols.md §12.2). */
  scaleRules: {
    track: [
      { mapScale: 15_000, factor: 1 },
      { mapScale: 12_500, factor: 1 },
      { mapScale: 10_000, factor: 1 },
      { mapScale: 7_500, factor: 1.33 },
      { mapScale: 5_000, factor: 1.5 },
    ],
    other: [
      { mapScale: 15_000, factor: 1 },
      { mapScale: 12_500, factor: 1.2 },
      { mapScale: 10_000, factor: 1.5 },
      { mapScale: 7_500, factor: 1.5 },
      { mapScale: 5_000, factor: 1.5 },
    ],
  },
  entries: withNamesAndAliases([...water, ...tracks] satisfies LibraryEntryInput[], SV, ALIASES),
};
