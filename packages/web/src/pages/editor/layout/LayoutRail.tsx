/**
 * Layout mode's tool rail (docs/course-layout.md §3; 08 §5.2 "in Layout
 * mode: frame, header, text, image, description block, whiteout"): `V`
 * select / move (the frame is selected with it), `H` header, `T` text, `I`
 * image (J8: the graphics picker opens beside the button; a picked graphic
 * arms the click), `D` description block, `W`
 * white-out, `L` line, `R` rectangle, `P` polygon,
 * the 1 mm grid toggle. The page owns the keyboard.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { GraphicPicker } from "../../../components/GraphicPicker";
import { LAYOUT_KEYS, type LayoutTool, type PlaceKind } from "./bindings";

const LABEL: Record<PlaceKind | "select", string> = {
  select: "toolSelect", header: "layoutToolHeader", text: "layoutToolText", image: "layoutToolImage", description: "layoutToolDescription",
  whiteout: "layoutToolWhiteout", line: "layoutToolLine", rectangle: "layoutToolRectangle", path: "layoutToolPath",
};

const BTN = "w-8 h-8 rounded-md text-xs font-semibold flex items-center justify-center";

export function LayoutRail(p: {
  tool: LayoutTool;
  onTool: (what: PlaceKind | "select") => void;
  /** `I`'s picker (J8): the event, whether the user may upload / delete, the pick that arms the click. */
  imagePicker: { nameId: string; canEdit: boolean; onPick: (graphicId: number) => void } | null;
  /** Template scope only: sheet scope edits its own objects too, so every tool is enabled. */
  snapping: boolean;
  onSnapping: () => void;
}) {
  const { t } = useTranslation("editor");
  const active = p.tool.kind === "select" ? "select" : p.tool.kind === "draw" ? "path" : p.tool.what;
  const imageButton = useRef<HTMLButtonElement | null>(null);
  const [pickerAt, setPickerAt] = useState<{ left: number; top: number } | null>(null);
  const imageOpen = active === "image" && !!p.imagePicker;
  const armed = p.tool.kind === "place" && p.tool.what === "image" ? p.tool.graphicId ?? null : null;
  useLayoutEffect(() => {
    if (!imageOpen) { setPickerAt(null); return; }
    const place = () => {
      const r = imageButton.current?.getBoundingClientRect();
      if (r) setPickerAt({ left: r.right + 6, top: Math.max(8, Math.min(r.top, window.innerHeight - 420)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [imageOpen]);
  return (
    <div data-testid="editor-layout-rail" className="pointer-events-auto relative flex flex-col gap-1 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm p-1 self-start">
      {Object.entries(LAYOUT_KEYS).map(([key, what]) => {
        const label = t(LABEL[what] as "toolSelect");
        const disabled = what === "image" && !p.imagePicker;
        return (
          <button key={key} ref={what === "image" ? imageButton : undefined} type="button" data-testid={`editor-layout-tool-${key}`} aria-pressed={active === what} disabled={disabled}
            title={label} aria-label={label} onClick={() => p.onTool(what)}
            className={`${BTN} ${active === what ? "bg-purple-100 text-purple-700" : "text-slate-600 hover:bg-slate-100"} disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer`}>
            {key}
          </button>
        );
      })}
      <div className="h-px bg-slate-200 my-0.5" />
      <button type="button" data-testid="editor-snapping" aria-pressed={p.snapping} title={t("layoutGrid")} aria-label={t("layoutGrid")} onClick={p.onSnapping}
        className={`${BTN} ${p.snapping ? "bg-purple-100 text-purple-700" : "text-slate-500 hover:bg-slate-100"} cursor-pointer`}>
        <svg viewBox="0 0 16 16" className="w-4 h-4" aria-hidden><path d="M2 5h12M2 11h12M5 2v12M11 2v12" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      {imageOpen && pickerAt && createPortal(
        <div data-testid="editor-layout-graphics" style={{ left: pickerAt.left, top: pickerAt.top }}
          className="fixed z-50 w-64 max-h-[400px] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg p-2 text-xs">
          {armed === null && <p data-testid="editor-layout-image-hint" className="mb-1.5 text-[11px] text-slate-500">{t("imagePickFirst")}</p>}
          <GraphicPicker nameId={p.imagePicker!.nameId} active={armed} onPick={p.imagePicker!.onPick} canEdit={p.imagePicker!.canEdit} testIdPrefix="editor-layout-graphic" />
        </div>,
        document.body,
      )}
    </div>
  );
}
