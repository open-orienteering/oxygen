/**
 * The editor's top bar (docs/course-editor.md §2; 08 §5.2): course picker,
 * view picker (Course · All controls), mode switch (Layout D7 and Field D9
 * shown, not yet enterable), undo / redo, hide other controls, auto cuts
 * and the help popover. It sits in `MapPanel`'s toolbar row, so it stays
 * in the fullscreen subtree; zoom and fullscreen are the viewer's and the
 * panel's own buttons on the same row.
 */

import { useTranslation } from "react-i18next";
import { EditorHelp } from "../../components/EditorHelp";
import { ToolbarButton } from "../../components/ToolbarButton";
import { IconEyeOff, IconRedo, IconScissors, IconUndo } from "../../components/map-icons";
import type { EditorMode, EditorView } from "../../lib/editor/state";

export interface TopBarProps {
  courses: { id: number; name: string }[];
  selectedCourseId: number | null;
  onSelectCourse: (id: number | null) => void;
  view: EditorView;
  onView: (view: EditorView) => void;
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
}

const MODES: { mode: EditorMode; key: "modeCourse" | "modeLayout" | "modeField"; slice?: string }[] = [
  { mode: "course", key: "modeCourse" },
  { mode: "layout", key: "modeLayout", slice: "D7" },
  { mode: "field", key: "modeField", slice: "D9" },
];

export function TopBar(p: TopBarProps) {
  const { t } = useTranslation("editor");
  const { t: tc } = useTranslation("courses");
  const segment = (active: boolean) =>
    `px-2 py-1 text-xs cursor-pointer disabled:cursor-default disabled:opacity-40 ${active ? "bg-purple-100 text-purple-700 font-medium" : "text-slate-600 hover:bg-slate-50"}`;
  return (
    <div className="flex items-center gap-1 sm:gap-2 min-w-0 flex-wrap" data-testid="editor-top-bar">
      <label className="flex items-center gap-1 text-xs text-slate-500">
        <span className="hidden sm:inline">{t("course")}</span>
        <select
          data-testid="editor-course-picker"
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
      </div>
      <div className="flex rounded-md border border-slate-200 overflow-hidden" role="group" aria-label={t("mode")}>
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            data-testid={`editor-mode-${m.mode}`}
            aria-pressed={p.mode === m.mode}
            disabled={!!m.slice}
            title={m.slice ? t("modeLater", { slice: m.slice }) : undefined}
            className={segment(p.mode === m.mode)}
            onClick={() => p.onMode(m.mode)}
          >
            {t(m.key)}
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
        disabled={p.selectedCourseId === null}
        active={p.hideOthers}
        onClick={p.onToggleHideOthers}
      />
      <ToolbarButton
        testId="editor-toggle-cuts"
        icon={<IconScissors />}
        label={tc("editor.toggleCuts")}
        title={tc("editor.toggleCutsTitle")}
        disabled={p.cutsBusy}
        active={p.cutsEnabled}
        onClick={p.onToggleCuts}
      />
      <EditorHelp hint={t("help")} label={tc("editor.helpAria")} />
    </div>
  );
}
