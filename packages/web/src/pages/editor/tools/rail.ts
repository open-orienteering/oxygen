/** The tool rail's keys (docs/course-editor.md §6; 08 §5.2): which tool lights which button. */

import type { EditorTool } from "../../../lib/editor/state";

export type RailTool = "V" | "S" | "K" | "M" | "X" | "C" | "A" | "T" | "G";

/** Map mode's tools (docs/course-editor.md §13): `V` select (G6), `N` nodes (G7), `P` / `L` / `A` point, line, area (G9). */
export type MapRailTool = "V" | "N" | "P" | "L" | "A";
/** Map mode's rail, in order. */
export const MAP_RAIL: readonly MapRailTool[] = ["V", "N", "P", "L", "A"];
/** Map mode's drawing tools (§13 "Drawing") and the kind each draws. */
export type MapDrawTool = "P" | "L" | "A";
export const MAP_DRAW_KIND: Record<MapDrawTool, "point" | "line" | "area"> = { P: "point", L: "line", A: "area" };
export const isMapDrawTool = (t: MapRailTool): t is MapDrawTool => t === "P" || t === "L" || t === "A";
export type AreaChoice = "oob_area" | "oob_line" | "whiteout" | "filter_region" | "toner_saver" | "marked_route";
export const AREA_CHOICES: AreaChoice[] = ["oob_area", "oob_line", "whiteout", "filter_region", "toner_saver", "marked_route"];

/** The second key of an `A` chord: `A` opens the menu, this key picks the kind (docs/course-editor.md §6.4). */
export const AREA_KEYS: Record<AreaChoice, string> = {
  oob_area: "O", oob_line: "L", whiteout: "W", filter_region: "F", toner_saver: "S", marked_route: "R",
};

/**
 * The `A` menu's *Corridor on selected leg* (08 §5.2 rail `A`;
 * docs/course-editor.md §6.4, §6.7): not an area kind — it writes the
 * selected leg's `LegProps.corridor` — so it is outside `AREA_CHOICES` (the
 * phone's + menu lists those) and has its own chord key, read only while
 * the menu is open. A plain `C` arms the crossing-point tool (§6.8).
 */
export const CORRIDOR_KEY = "C";
export const isCorridorKey = (key: string): boolean => key.toUpperCase() === CORRIDOR_KEY;

/** The area kind an `A`-menu key picks, or null. */
export function areaChoiceOfKey(key: string): AreaChoice | null {
  const k = key.toUpperCase();
  return AREA_CHOICES.find((c) => AREA_KEYS[c] === k) ?? null;
}

/** The rail key a tool lights up; null for the inspector's eyedropper (§6.4), which lights its own button. */
export function railKeyOf(tool: EditorTool): RailTool | null {
  switch (tool.kind) {
    case "select": return "V";
    case "place": return { start: "S", control: "K", finish: "M", crossing: "C", exchange: "X" }[tool.chain.tool] as RailTool;
    case "area": return "A";
    case "text": return "T";
    case "gap": return "G";
    case "pick-symbol": return null;
  }
}
