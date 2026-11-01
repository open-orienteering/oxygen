/** The tool rail's keys (docs/course-editor.md §6; 08 §5.2): which tool lights which button. */

import type { EditorTool } from "../../../lib/editor/state";

export type RailTool = "V" | "S" | "K" | "M" | "A" | "T" | "G";
export type AreaChoice = "oob_area" | "oob_line" | "whiteout" | "filter_region" | "toner_saver" | "marked_route";
export const AREA_CHOICES: AreaChoice[] = ["oob_area", "oob_line", "whiteout", "filter_region", "toner_saver", "marked_route"];

/** The rail key a tool lights up. */
export function railKeyOf(tool: EditorTool): RailTool {
  switch (tool.kind) {
    case "select": return "V";
    case "place": return tool.chain.tool === "start" ? "S" : tool.chain.tool === "finish" ? "M" : "K";
    case "area": return "A";
    case "text": return "T";
    case "gap": return "G";
  }
}
