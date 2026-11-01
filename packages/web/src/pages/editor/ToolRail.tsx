/**
 * The tool rail (docs/course-editor.md §2, §6; 08 §5.2): `V` select / move,
 * the armed creation tools `S` / `K` / `M`, `A` areas (a menu of kinds),
 * `T` map text, `G` gaps on the selected circle or leg, and the snapping
 * toggle. Map exchange `X` and crossing point `C` are shown disabled
 * until slice F. Every tool has its key; the page owns the keyboard.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditorTool } from "../../lib/editor/state";

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

export interface ToolRailProps {
  tool: EditorTool;
  onTool: (key: Exclude<RailTool, "A">) => void;
  onArea: (kind: AreaChoice) => void;
  /** A control circle or a leg is selected (G applies). */
  canGap: boolean;
  /** The toner saver needs a course with positioned sites. */
  canTonerSaver: boolean;
  snapping: boolean;
  onSnapping: () => void;
}

const BTN = "w-8 h-8 rounded-md text-xs font-semibold flex items-center justify-center";

export function ToolRail(p: ToolRailProps) {
  const { t } = useTranslation("editor");
  const [areaOpen, setAreaOpen] = useState(false);
  const active = railKeyOf(p.tool);
  const button = (key: RailTool, label: string, onClick: () => void, disabled = false, title = label) => (
    <button
      key={key}
      type="button"
      data-testid={`editor-tool-${key}`}
      aria-pressed={active === key}
      disabled={disabled}
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`${BTN} ${active === key ? "bg-purple-100 text-purple-700" : "text-slate-600 hover:bg-slate-100"} disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer`}
    >
      {key}
    </button>
  );
  const later = (key: "X" | "C", name: string) => (
    <button key={key} type="button" data-testid={`editor-tool-${key}`} disabled title={t("toolLater", { tool: name })} aria-label={t("toolLater", { tool: name })}
      className={`${BTN} text-slate-400 opacity-40 cursor-not-allowed`}>
      {key}
    </button>
  );
  return (
    <div data-testid="editor-tool-rail" className="pointer-events-auto relative flex flex-col gap-1 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm p-1 self-start">
      {button("V", t("toolSelect"), () => p.onTool("V"))}
      {button("S", t("toolStart"), () => p.onTool("S"))}
      {button("K", t("toolControl"), () => p.onTool("K"))}
      {button("M", t("toolFinish"), () => p.onTool("M"))}
      {later("X", t("toolExchange"))}
      {later("C", t("toolCrossing"))}
      {button("A", t("toolArea"), () => setAreaOpen((v) => !v))}
      {button("T", t("toolText"), () => p.onTool("T"))}
      {button("G", t("toolGap"), () => p.onTool("G"), !p.canGap)}
      <div className="h-px bg-slate-200 my-0.5" />
      <button type="button" data-testid="editor-snapping" aria-pressed={p.snapping} title={t("snapping")} aria-label={t("snapping")} onClick={p.onSnapping}
        className={`${BTN} ${p.snapping ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"} cursor-pointer`}>
        <svg viewBox="0 0 16 16" className="w-4 h-4" aria-hidden><path d="M4 2v6a4 4 0 0 0 8 0V2M4 5h3M9 5h3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      </button>
      {areaOpen && (
        <div data-testid="editor-area-menu" role="menu" className="absolute left-full top-[13.5rem] ml-1 z-10 w-44 bg-white border border-slate-200 rounded-lg shadow-lg py-1 text-xs">
          {AREA_CHOICES.map((kind) => (
            <button key={kind} type="button" role="menuitem" data-testid={`editor-area-${kind}`}
              disabled={kind === "toner_saver" && !p.canTonerSaver}
              onClick={() => { setAreaOpen(false); p.onArea(kind); }}
              className="w-full text-left px-2.5 py-1.5 hover:bg-purple-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
              {t(`kind_${kind}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
