/** Shared constants for the ISOM 2017-2 Rev 6 library. */

import { authorFor } from "../authoring.js";

export const LIBRARY_ID = "ISOM2017-2";
export const CITATION = "ISOM 2017-2 Rev 6 (IOF Map Commission, 2024), §3.8";

export const entry = authorFor(LIBRARY_ID, CITATION);

/** Source of every heading's `name.sv` (docs/map-symbols.md §3); headings are reproduced verbatim under its licence. */
export const SV_SOURCE = "ISOM 2017-2 Internationella Kartnormen, svensk översättning, revision 6 (Svenska Orienteringsförbundet, 1 mars 2024), CC BY-ND 4.0";

/** Source of the `aliases` (docs/map-symbols.md §3). */
export const ALIAS_SOURCE = "ISOM 2000 → ISOM 2017 pairs from OpenOrienteering Mapper's ISOM2000-ISOM_2017-2.crt (© Kai Pastor, GPL-3), checked against IOF \"ISOM 2017 – What has changed from ISOM 2000?\" (ČSOS translation)";

/** Palette ids used by ISOM symbols (docs/map-symbols.md §3). */
export const C = {
  black: "black100",
  blackOutline: "black-road-outline",
  blackCultivated: "black-cultivated",
  black50: "black50-building",
  black20: "black20-canopy",
  blackScreen: "black-area-screen",
  brownLine: "brown100-line",
  brownPoint: "brown100-point",
  brownRoad: "brown50-road",
  brownPaved: "brown50-paved",
  blueLine: "blue100-line",
  bluePoint: "blue100-point",
  blueArea: "blue100-area",
  blue70: "blue70-area",
  blue50: "blue50-area",
  greenPoint: "green100-point",
  greenArea: "green100-area",
  green60: "green60-area",
  green30: "green30-area",
  whiteGB: "white-over-green-brown",
  whiteYellow: "white-over-yellow",
  whiteRail: "white-railway",
  olive: "olive",
  yellow: "yellow100",
  yellow50: "yellow50",
  purpleLower: "purple-lower",
  purpleUpper: "purple-upper",
} as const;

/** Dash fitting: the majority of source maps are OCAD exports (03 §6.4). */
export const DASH_NOTE = "Dash fitting follows OCAD (sections start and end with a full dash).";
