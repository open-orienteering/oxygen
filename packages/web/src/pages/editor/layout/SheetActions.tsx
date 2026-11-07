/**
 * What the Maps page did for a sheet, now in Layout mode (docs/course-layout.md
 * §2 "Scope"; E-pages):
 *
 * - **Sheet scope** (`SheetActions`): rename the sheet (`courseMap.update`
 *   with the sheet's version token, one undo entry), add a second sheet of
 *   the course on the same template, delete the sheet. Create and delete
 *   are not undo entries (as the editor's course create).
 * - **Template scope** (`TemplateActions`): *New template* (paper,
 *   orientation, scale; it opens), *Delete this template* (its sheets keep
 *   their layout without a template). The template's name is part of the
 *   snapshot (one undo entry with the rest of the template).
 * - **No sheet** (`NoSheetActions`): *Create sheet* for the top bar's course
 *   (`layout.autoSheets { courseId }`, which also gives a template-less
 *   sheet its template); in view All, *Create the all-controls sheet*
 *   (`layout.autoSheets { allControls: true }`).
 *
 * Every write goes through the page's `run` (pending count, error line, the
 * refresh notice on a stale token).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../../../lib/trpc";
import { versionConflictOfError, type VersionBook } from "../../../lib/version-book";
import { EditorConflict } from "../../../lib/editor/write-client";
import type { EditorView } from "../../../lib/editor/state";
import type { LayoutTarget } from "./bindings";
import { nextSheetName, type EditorSheet } from "./model";
import { TextField } from "./fields";
import { NewTemplateForm } from "../../../components/NewTemplateForm";

export type Run = <T>(op: () => Promise<T>) => Promise<T | undefined>;
export type Record_ = (undo: () => Promise<unknown>, redo: () => Promise<unknown>) => unknown;

const LINK = "text-[11px] text-purple-700 hover:underline cursor-pointer disabled:opacity-50";

function useRefresh() {
  const utils = trpc.useUtils();
  return async () => {
    await Promise.all([
      utils.courseMap.list.invalidate(),
      utils.courseMap.resolveSheet.invalidate(),
      utils.mapTemplate.list.invalidate(),
      utils.layout.classOverrides.invalidate(),
    ]);
  };
}

export function SheetActions(p: {
  sheet: NonNullable<EditorSheet["sheet"]>;
  templateSeq: number;
  /** The course's own sheets (siblings of this one, itself included). */
  siblings: readonly { seq: number; name: string }[];
  courseName: string | null;
  canEdit: boolean;
  versions: VersionBook;
  run: Run;
  record: Record_;
  onOpen: (t: LayoutTarget | null) => void;
}) {
  const { t } = useTranslation("editor");
  const client = trpc.useUtils().client;
  const refresh = useRefresh();
  if (!p.canEdit) return null;
  const { sheet, versions } = p;
  // A class sheet follows its class's override (autoSheets); only a course's own sheets and the all-controls sheet are managed here.
  const own = sheet.classSeq === null;

  const rename = async (name: string) => {
    const id = sheet.seq, prev = sheet.name;
    const write = (n: string) => async () => {
      try {
        const r = await client.courseMap.update.mutate({ id, name: n, baseVersion: versions.get("sheet", id) });
        versions.seed("sheet", id, r.version);
      } catch (e) {
        const conflict = versionConflictOfError(e);
        if (!conflict) throw e;
        versions.seed("sheet", id, conflict.version);
        void refresh();
        throw new EditorConflict({ kind: "refresh", differing: null }, "sheet", id);
      }
      await refresh();
      return true;
    };
    if ((await p.run(write(name))) !== undefined) p.record(write(prev), write(name));
  };

  const add = async () => {
    if (sheet.courseSeq === null) return;
    const base = p.courseName ?? sheet.name;
    const created = await p.run(async () => {
      const row = await client.courseMap.create.mutate({
        kind: "course", courseId: sheet.courseSeq, templateId: p.templateSeq, overrides: {}, objects: [],
        name: nextSheetName(base, p.siblings.map((s) => s.name)),
      });
      await refresh();
      return row;
    });
    if (created) p.onOpen({ sheet: created.seq });
  };

  const remove = async () => {
    if (!window.confirm(t("layoutDeleteSheetConfirm", { name: sheet.name }))) return;
    await p.run(async () => {
      await client.courseMap.delete.mutate({ id: sheet.seq });
      // Off the deleted sheet first, so the refresh does not read it again.
      p.onOpen(null);
      await refresh();
      return true;
    });
  };

  return (
    <div className="space-y-1" data-testid="editor-layout-sheet-actions">
      <TextField label={t("layoutSheetName")} value={sheet.name} testId="editor-layout-sheet-name"
        onCommit={(v) => { const name = v.trim(); if (name && name !== sheet.name) void rename(name); }} />
      {own && (
        <div className="flex items-center gap-3">
          {sheet.kind === "course" && (
            <button type="button" data-testid="editor-layout-add-sheet" onClick={() => void add()} className={LINK}>{t("layoutAddSheet")}</button>
          )}
          <button type="button" data-testid="editor-layout-delete-sheet" onClick={() => void remove()} className="text-[11px] text-red-600 hover:underline cursor-pointer">
            {t("layoutDeleteSheet")}
          </button>
        </div>
      )}
    </div>
  );
}

export function NoSheetActions(p: {
  view: EditorView;
  course: { id: number; name: string } | null;
  canEdit: boolean;
  run: Run;
  onOpen: (t: LayoutTarget | null) => void;
}) {
  const { t } = useTranslation("editor");
  const client = trpc.useUtils().client;
  const refresh = useRefresh();
  if (p.view === "all") {
    return (
      <div className="space-y-1">
        <p data-testid="editor-layout-no-all-controls" className="text-[11px] text-slate-500">{t("layoutNoAllControls")}</p>
        {p.canEdit && (
          <button type="button" data-testid="editor-layout-create-all-controls" className={LINK}
            onClick={() => void p.run(async () => {
              const r = await client.layout.autoSheets.mutate({ allControls: true });
              await refresh();
              if (r.allControlsSheet !== null) p.onOpen({ sheet: r.allControlsSheet });
              return r;
            })}>
            {t("layoutCreateAllControls")}
          </button>
        )}
      </div>
    );
  }
  if (!p.course) return <p className="text-[11px] text-slate-500">{t("layoutNoCourse")}</p>;
  const courseId = p.course.id;
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-slate-500">{t("layoutNoSheet")}</p>
      {p.canEdit && (
        <button type="button" data-testid="editor-layout-create-sheet" className={LINK}
          onClick={() => void p.run(async () => {
            const r = await client.layout.autoSheets.mutate({ courseId });
            await refresh();
            p.onOpen(null);
            return r;
          })}>
          {t("layoutCreateSheet")}
        </button>
      )}
    </div>
  );
}

export function TemplateActions(p: {
  template: { seq: number; name: string };
  canEdit: boolean;
  run: Run;
  onOpen: (t: LayoutTarget | null) => void;
}) {
  const { t } = useTranslation("editor");
  const client = trpc.useUtils().client;
  const refresh = useRefresh();
  const [creating, setCreating] = useState(false);
  if (!p.canEdit) return null;

  const remove = async () => {
    if (!window.confirm(t("layoutDeleteTemplateConfirm", { name: p.template.name }))) return;
    await p.run(async () => {
      await client.mapTemplate.delete.mutate({ id: p.template.seq });
      p.onOpen(null);
      await refresh();
      return true;
    });
  };

  return (
    <div className="space-y-1" data-testid="editor-layout-template-actions">
      {creating ? (
        <NewTemplateForm
          onCancel={() => setCreating(false)}
          onSubmit={(payload) => void p.run(async () => {
            const row = await client.mapTemplate.create.mutate(payload);
            await refresh();
            setCreating(false);
            p.onOpen({ template: row.seq });
            return row;
          })}
        />
      ) : (
        <div className="flex items-center gap-3">
          <button type="button" data-testid="editor-layout-new-template" onClick={() => setCreating(true)} className={LINK}>{t("layoutNewTemplate")}</button>
          <button type="button" data-testid="editor-layout-delete-template" onClick={() => void remove()} className="text-[11px] text-red-600 hover:underline cursor-pointer">
            {t("layoutDeleteTemplate")}
          </button>
        </div>
      )}
    </div>
  );
}
