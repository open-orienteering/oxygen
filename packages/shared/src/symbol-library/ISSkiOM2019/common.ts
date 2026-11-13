/** Shared constants for the ISSkiOM 2019 Revision 4 overlay library (docs/map-symbols.md §12). */

import { type Author, authorFor } from "../authoring.js";

export const LIBRARY_ID = "ISSkiOM2019";
export const EDITION = "ISSkiOM 2019 Revision 4 (IOF Map Commission, September 2026)";

const trackAuthor = authorFor(LIBRARY_ID, `${EDITION}, §3.3.1`);
const otherAuthor = authorFor(LIBRARY_ID, `${EDITION}, §3.3.2`);

/** §3.3.1 track symbols: enlarged by the "Track symbols" column of §3.2. */
export const trackEntry: Author = (code, en, specType, render, opts = {}) => trackAuthor(code, en, specType, render, { scaleGroup: "track", ...opts });
/** §3.3.2 other symbols: enlarged by the "Other symbols" column of §3.2. */
export const otherEntry: Author = (code, en, specType, render, opts = {}) => otherAuthor(code, en, specType, render, { scaleGroup: "other", ...opts });

/** No Swedish ISSkiOM text from SOFT exists (docs/map-symbols.md §12.4). */
export const SV_SOURCE: string | null = null;

/** Palette ids used by ISSkiOM symbols (docs/map-symbols.md §12.3). */
export const C = {
  green: "green-skio",
  orange: "orange-skio",
  black: "black100",
  mask: "white-skio",
  green100: "green100-area",
  blueLine: "blue100-line",
  blueArea: "blue100-area",
  blue50: "blue50-area",
} as const;

export const DASH_NOTE = "Dash fitting follows OCAD (sections start and end with a full dash).";
