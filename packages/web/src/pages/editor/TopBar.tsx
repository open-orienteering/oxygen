/**
 * The editor's top bar (docs/course-editor.md §2; 08 §5.2): course picker,
 * view picker (Course · All controls · Class, docs/course-layout.md §6),
 * mode switch (Course · Layout · Field), undo / redo, hide other controls,
 * auto cuts, Export ▾ (docs/course-layout.md §7) and the help popover. It sits in `MapPanel`'s toolbar row, so it stays
 * in the fullscreen subtree; zoom and fullscreen are the viewer's and the
 * panel's own buttons on the same row.
 */

import { useTranslation } from "react-i18next";
import { EditorHelp } from "../../components/EditorHelp";
import { ToolbarButton } from "../../components/ToolbarButton";
import { IconEyeOff, IconRedo, IconScissors, IconUndo } from "../../components/map-icons";
import type { EditorMode, EditorView } from "../../lib/editor/state";
import type { ExportState } from "../../lib/editor/export-menu";
import { ExportMenu } from "./ExportMenu";

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
}

const MODES: { mode: EditorMode; key: "modeCourse" | "modeLayout" | "modeField"; slice?: string }[] = [
  { mode: "course", key: "modeCourse" },
  { mode: "layout", key: "modeLayout" },
  { mode: "field", key: "modeField" },
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
      <ExportMenu state={p.exportState} onError={p.onExportError} />
      <EditorHelp hint={t("help")} label={tc("editor.helpAria")} />
    </div>
  );
}
