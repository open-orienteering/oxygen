/**
 * The editor's top bar (docs/course-editor.md §2; 08 §5.2): course picker,
 * view picker (Course · All controls · Class, docs/course-layout.md §6),
 * mode switch (Course · Layout · Field), undo / redo, hide other controls,
 * auto cuts, the placement loupe toggle (F27, §10 "Loupe"), Export ▾ (docs/course-layout.md §7), the map info (a map icon and
 * its dialog, docs/course-editor.md §2; P6 moved it here from MapPanel's
 * footer), the save indicator and the
 * course-info popover (docs/course-editor.md §2, §3; P2 moved them here from the
 * status bar), who else has a course open (docs/course-editor.md §11) and the help popover. It sits in `MapPanel`'s toolbar row, so it stays
 * in the fullscreen subtree; zoom and fullscreen are the viewer's and the
 * panel's own buttons on the same row. When that row is short it collapses
 * in two tiers on its own width (F29, `components/top-bar-collapse.ts`,
 * docs/course-editor.md §2 "Top bar"): first the labels, then the mode
 * words; every control keeps its accessible name.
 */

import { useTranslation } from "react-i18next";
import { EditorHelp } from "../../components/EditorHelp";
import { ToolbarButton } from "../../components/ToolbarButton";
import { IconEyeOff, IconLoupe, IconModeCourse, IconModeField, IconModeLayout, IconRedo, IconScissors, IconUndo } from "../../components/map-icons";
import { TOP_BAR_TIER1_HIDE, TOP_BAR_TIER2_HIDE, TOP_BAR_TIER2_SHOW } from "../../components/top-bar-collapse";
import type { ReactNode } from "react";
import type { EditorMode, EditorView } from "../../lib/editor/state";
import type { ExportState } from "../../lib/editor/export-menu";
import { ExportMenu } from "./ExportMenu";
import { SaveIndicator, StatsButton } from "./EditorStatus";
import type { SaveState, StatusInput } from "../../lib/editor/status";
import { MapInfoButton } from "./MapInfoDialog";
import type { MapInfoInput } from "../../lib/editor/map-info";

export interface TopBarProps {
  courses: { id: number; name: string }[];
  selectedCourseId: number | null;
  onSelectCourse: (id: number | null) => void;
  view: EditorView;
  onView: (view: EditorView) => void;
  /** The selected course's classes (Class view's picker). */
  classes: { seq: number; name: string }[];
  classSeq: number | null;
  onClass: (seq: number | null) => void;
  /** The selected course's variant keys (docs/course-editor.md §12): Variant ▾ and All variations; empty without groups. */
  variants?: string[];
  /** The key Variant ▾ shows: Variant view's, or the variant Class view / Layout mode draw (F8). */
  variantKey?: string | null;
  onVariant?: (key: string | null) => void;
  /** All variations is Course mode's (screen only, §12); Layout mode draws one variant as it prints (F8). */
  allVariations?: boolean;
  exportState: ExportState;
  onExportError: (message: string) => void;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  hideOthers: boolean;
  onToggleHideOthers: () => void;
  cutsEnabled: boolean;
  cutsBusy: boolean;
  onToggleCuts: () => void;
  /** The placement loupe toggle (F27): lit when on; `L` toggles it too. */
  placementLoupe: boolean;
  onTogglePlacementLoupe: () => void;
  /** Who else has a course open (`PresenceChips`, D11). */
  presence?: ReactNode;
  /** The autosave state (§3): always in sight. */
  save: SaveState;
  /** The course-info popover's values (§2); the map scale is the map-info dialog's (P6). */
  status: Omit<StatusInput, "scale">;
  /** The map-info dialog's values (§2, P6). */
  map: MapInfoInput;
}

const MODES: { mode: EditorMode; key: "modeCourse" | "modeLayout" | "modeField"; icon: ReactNode; slice?: string }[] = [
  { mode: "course", key: "modeCourse", icon: <IconModeCourse /> },
  { mode: "layout", key: "modeLayout", icon: <IconModeLayout /> },
  { mode: "field", key: "modeField", icon: <IconModeField /> },
];

export function TopBar(p: TopBarProps) {
  const { t } = useTranslation("editor");
  const { t: tc } = useTranslation("courses");
  const segment = (active: boolean) =>
    `px-2 py-1 text-xs cursor-pointer disabled:cursor-default disabled:opacity-40 ${active ? "bg-purple-100 text-purple-700 font-medium" : "text-slate-600 hover:bg-slate-50"}`;
  return (
    <div className="flex items-center gap-1 sm:gap-2 min-w-0 flex-wrap" data-testid="editor-top-bar">
      <label className="flex items-center gap-1 text-xs text-slate-500">
        <span data-toolbar-label="" className={`hidden sm:inline ${TOP_BAR_TIER1_HIDE}`}>{t("course")}</span>
        <select
          data-testid="editor-course-picker"
          aria-label={t("course")}
          value={p.selectedCourseId ?? ""}
          onChange={(e) => p.onSelectCourse(e.target.value === "" ? null : Number(e.target.value))}
          className="max-w-[10rem] text-xs border border-slate-200 rounded-md px-1.5 py-1 bg-white"
        >
          <option value="">{t("noCourse")}</option>
          {p.courses.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <div className="flex rounded-md border border-slate-200 overflow-hidden" role="group" aria-label={t("view")}>
        <button type="button" data-testid="editor-view-course" aria-pressed={p.view === "course"} className={segment(p.view === "course")} onClick={() => p.onView("course")}>{t("viewCourse")}</button>
        <button type="button" data-testid="editor-view-all" aria-pressed={p.view === "all"} className={segment(p.view === "all")} onClick={() => p.onView("all")}>{t("viewAll")}</button>
        {p.classes.length > 0 && (
          <select
            data-testid="editor-view-class"
            aria-label={t("viewClass")}
            value={p.view === "class" && p.classSeq !== null ? p.classSeq : ""}
            onChange={(e) => p.onClass(e.target.value === "" ? null : Number(e.target.value))}
            className={`max-w-[7rem] text-xs border-0 border-l border-slate-200 px-1 py-1 cursor-pointer ${p.view === "class" ? "bg-purple-100 text-purple-700 font-medium" : "bg-white text-slate-600"}`}
          >
            <option value="">{t("viewClass")}</option>
            {p.classes.map((c) => (
              <option key={c.seq} value={c.seq}>{c.name}</option>
            ))}
          </select>
        )}
        {(p.variants?.length ?? 0) > 0 && (
          <>
            <select
              data-testid="editor-view-variant"
              aria-label={t("viewVariant")}
              title={t("viewVariantHint")}
              value={p.variantKey ?? ""}
              onChange={(e) => p.onVariant?.(e.target.value === "" ? null : e.target.value)}
              className={`max-w-[6rem] text-xs border-0 border-l border-slate-200 px-1 py-1 cursor-pointer ${p.view === "variant" ? "bg-purple-100 text-purple-700 font-medium" : "bg-white text-slate-600"}`}
            >
              <option value="">{t("viewVariant")}</option>
              {p.variants!.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            {p.allVariations !== false && <button type="button" data-testid="editor-view-all-variations" aria-pressed={p.view === "all-variations"} title={t("viewAllVariationsHint")}
              className={`border-l border-slate-200 ${segment(p.view === "all-variations")}`} onClick={() => p.onView(p.view === "all-variations" ? "course" : "all-variations")}>{t("viewAllVariations")}</button>}
          </>
        )}
      </div>
      <div className="flex rounded-md border border-slate-200 overflow-hidden" role="group" aria-label={t("mode")}>
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            data-testid={`editor-mode-${m.mode}`}
            aria-pressed={p.mode === m.mode}
            disabled={!!m.slice}
            title={m.slice ? t("modeLater", { slice: m.slice }) : t(m.key)}
            aria-label={t(m.key)}
            className={`inline-flex items-center ${segment(p.mode === m.mode)}`}
            onClick={() => p.onMode(m.mode)}
          >
            {/* Tier 2 (F29): the icon alone when the row is short; the word stays the name and the tooltip. */}
            <span data-toolbar-icon="" className={`${TOP_BAR_TIER2_SHOW} shrink-0 [&>svg]:w-4 [&>svg]:h-4`}>{m.icon}</span>
            <span data-toolbar-label="" className={TOP_BAR_TIER2_HIDE}>{t(m.key)}</span>
          </button>
        ))}
      </div>
      <span className="w-px h-4 bg-slate-200 shrink-0" />
      <ToolbarButton testId="editor-undo" iconOnly icon={<IconUndo />} label={tc("editor.undo")} disabled={!p.canUndo} onClick={p.onUndo} />
      <ToolbarButton testId="editor-redo" iconOnly icon={<IconRedo />} label={tc("editor.redo")} disabled={!p.canRedo} onClick={p.onRedo} />
      <ToolbarButton
        testId="editor-hide-others"
        icon={<IconEyeOff />}
        label={tc("editor.hideOtherControls")}
        labelClassName={TOP_BAR_TIER1_HIDE}
        disabled={p.selectedCourseId === null}
        active={p.hideOthers}
        onClick={p.onToggleHideOthers}
      />
      <ToolbarButton
        testId="editor-toggle-cuts"
        icon={<IconScissors />}
        label={tc("editor.toggleCuts")}
        title={tc("editor.toggleCutsTitle")}
        labelClassName={TOP_BAR_TIER1_HIDE}
        disabled={p.cutsBusy}
        active={p.cutsEnabled}
        onClick={p.onToggleCuts}
      />
      <ToolbarButton
        testId="editor-placement-loupe"
        iconOnly
        icon={<IconLoupe />}
        label={tc("editor.placementLoupe")}
        title={tc("editor.placementLoupeTitle")}
        active={p.placementLoupe}
        onClick={p.onTogglePlacementLoupe}
      />
      <ExportMenu state={p.exportState} onError={p.onExportError} />
      <MapInfoButton map={p.map} />
      <StatsButton status={p.status} />
      <SaveIndicator save={p.save} />
      {p.presence}
      <EditorHelp hint={t("help")} label={tc("editor.helpAria")} />
    </div>
  );
}
