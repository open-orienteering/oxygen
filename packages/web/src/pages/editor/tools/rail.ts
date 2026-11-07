/** The tool rail's keys (docs/course-editor.md §6; 08 §5.2): which tool lights which button. */

import type { EditorTool } from "../../../lib/editor/state";

export type RailTool = "V" | "S" | "K" | "M" | "A" | "T" | "G";
export type AreaChoice = "oob_area" | "oob_line" | "whiteout" | "filter_region" | "toner_saver" | "marked_route";
export const AREA_CHOICES: AreaChoice[] = ["oob_area", "oob_line", "whiteout", "filter_region", "toner_saver", "marked_route"];

/** The second key of an `A` chord: `A` opens the menu, this key picks the kind (docs/course-editor.md §6.4). */
export const AREA_KEYS: Record<AreaChoice, string> = {
  oob_area: "O", oob_line: "L", whiteout: "W", filter_region: "F", toner_saver: "S", marked_route: "R",
};

/** The area kind an `A`-menu key picks, or null. */
export function areaChoiceOfKey(key: string): AreaChoice | null {
  const k = key.toUpperCase();
  return AREA_CHOICES.find((c) => AREA_KEYS[c] === k) ?? null;
}

/** The rail key a tool lights up; null for the inspector's eyedropper (§6.4), which lights its own button. */
export function railKeyOf(tool: EditorTool): RailTool | null {
  switch (tool.kind) {
    case "select": return "V";
    case "place": return tool.chain.tool === "start" ? "S" : tool.chain.tool === "finish" ? "M" : "K";
    case "area": return "A";
    case "text": return "T";
    case "gap": return "G";
    case "pick-symbol": return null;
  }
}
