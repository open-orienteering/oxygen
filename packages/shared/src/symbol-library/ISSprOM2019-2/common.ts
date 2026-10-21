/** Shared constants for the ISSprOM 2019-2 Rev 6 library. */

import { authorFor } from "../authoring.js";

export const LIBRARY_ID = "ISSprOM2019-2";
export const CITATION = "ISSprOM 2019-2 Rev 6 (IOF Map Commission, 2024), §4.8";

export const entry = authorFor(LIBRARY_ID, CITATION);

/** Source of every heading's `name.sv` (docs/map-symbols.md §3); headings are reproduced verbatim under its licence. */
export const SV_SOURCE = "ISSprOM 2019-2 Internationella Sprintnormen, svensk översättning, revision 5 (Svenska Orienteringsförbundet, 1 oktober 2022), CC BY-ND 4.0";

/** Palette ids used by ISSprOM symbols (docs/map-symbols.md §3). */
export const C = {
  black: "black100",
  blackOutline: "black-road-outline",
  blackCultivated: "black-cultivated",
  black50: "black50-building",
  black20: "black20-canopy",
  blackScreen: "black-area-screen",
  brown: "brown100",
  brown50Road: "brown50-road",
  brown30Road: "brown30-road",
  brown50Paved: "brown50-paved",
  brown30Paved: "brown30-paved",
  blue: "blue100-pointline",
  blueArea: "blue100-area",
  blue70: "blue70-area",
  blue30: "blue30-area",
  greenPoint: "green100-point",
  greenArea: "green100-area",
  green60: "green60-area",
  green30: "green30-area",
  darkGreenArea: "darkgreen-area",
  whiteGB: "white-over-green-brown",
  whiteYellow: "white-over-yellow",
  whiteRail: "white-railway",
  whiteTwoLevel: "white-two-level",
  whiteUpper: "white-upper",
  olive: "olive",
  yellow: "yellow100",
  yellow50: "yellow50",
  purpleLower: "purple-lower",
  purpleUpper: "purple-upper",
  purple50: "purple50",
} as const;

export const DASH_NOTE = "Dash fitting follows OCAD (sections start and end with a full dash).";
