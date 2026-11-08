/**
 * Layout inspector sections of D8 (docs/course-layout.md §5–§6; 08 §4.4,
 * §4.6):
 *
 * - **Template** (`editor-layout-template-key`): the template's key and
 *   whether it is the key's auto template or an extra one; *Create extra
 *   template* (a copy of this one, so an extra of its key; in sheet scope
 *   the sheet's course moves to it); "courses in this template" and "other
 *   courses at this scale" — a course moves between them by drag, or by
 *   its row's button (`mapTemplate.applyToCourses`).
 * - **Classes** (`editor-layout-classes`): the course's classes with their
 *   print overrides (scale, template); a change is `layout.setClassOverride`,
 *   which also brings the class sheets in line; *Open* shows a class sheet.
 *
 * - **Club templates** (`editor-layout-club`, collapsed; E-pages): the club
 *   library — *Bring in* copies one into the event and opens it, *Delete*
 *   removes it from the library; *Save this template to the club library*.
 *   These are not undo entries (the library is shared between events).
 *
 * Each write of the first two goes through the page's `run` and is one undo entry.
 */

import { useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../../../lib/trpc";
import { freeTemplateName } from "../../../lib/template-picker";
import { extraTemplateName, moveOutTarget, templateCourses, type KeyCourse, type SheetRow } from "../../../lib/editor/template-key";
import { InspectorSection } from "../Inspector";
import type { LayoutTarget } from "./bindings";

type Run = <T>(op: () => Promise<T>) => Promise<T | undefined>;
type Record_ = (undo: () => Promise<unknown>, redo: () => Promise<unknown>) => unknown;

export function TemplateKeySection(p: {
  template: { seq: number; name: string; autoKey: string | null; isExtra: boolean };
  /** The sheet's course in sheet scope (moves to a new extra template). */
  sheetCourse: number | null;
  sheets: readonly SheetRow[];
  canEdit: boolean;
  run: Run;
  record: Record_;
  onOpen: (t: LayoutTarget | null) => void;
}) {
  const { t } = useTranslation("editor");
  const utils = trpc.useUtils();
  const templates = trpc.mapTemplate.list.useQuery();
  const [dragging, setDragging] = useState<KeyCourse | null>(null);
  const list = templates.data ?? [];
  const lists = templateCourses(p.sheets, p.template);
  const outTo = moveOutTarget(list, p.template);
  const refresh = () => {
    void utils.courseMap.list.invalidate();
    void utils.courseMap.resolveSheet.invalidate();
    void utils.mapTemplate.list.invalidate();
  };

  /** Move a course's own sheets to `to`; undo moves them back. */
  const move = async (c: KeyCourse, to: number) => {
    const from = c.templateSeq;
    const write = (seq: number) => async () => {
      await utils.client.mapTemplate.applyToCourses.mutate({ templateId: seq, courseIds: [c.seq] });
      refresh();
      // `run` answers undefined for a failed write: a successful one answers something.
      return true;
    };
    if ((await p.run(write(to))) !== undefined) p.record(write(from), write(to));
  };

  const createExtra = async () => {
    const name = extraTemplateName(p.template.name, new Set(list.map((x) => x.name)), t("layoutExtraWord"));
    const created = await p.run(async () => {
      const row = await utils.client.mapTemplate.duplicate.mutate({ id: p.template.seq, name });
      if (p.sheetCourse !== null) await utils.client.mapTemplate.applyToCourses.mutate({ templateId: row.seq, courseIds: [p.sheetCourse] });
      refresh();
      return row;
    });
    // A sheet keeps showing (now on the extra template); in template scope the new template opens.
    if (created && p.sheetCourse === null) p.onOpen({ template: created.seq });
  };

  const drop = (into: "in" | "out") => (e: DragEvent) => {
    e.preventDefault();
    const c = dragging;
    setDragging(null);
    if (!c) return;
    if (into === "in" && c.templateSeq !== p.template.seq) void move(c, p.template.seq);
    if (into === "out" && c.templateSeq === p.template.seq && outTo !== null) void move(c, outTo);
  };

  const row = (c: KeyCourse, side: "in" | "out") => {
    const target = side === "in" ? outTo : p.template.seq;
    return (
      <li key={c.seq} data-testid={`editor-layout-template-course-${c.seq}`} data-side={side}
        draggable={p.canEdit && target !== null} onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.name); setDragging(c); }} onDragEnd={() => setDragging(null)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-50 cursor-grab">
        <span className="truncate">{c.name}</span>
        {p.canEdit && target !== null && (
          <button type="button" data-testid={`editor-layout-template-move-${c.seq}`} onClick={() => void move(c, target)}
            title={side === "in" ? t("layoutMoveOut") : t("layoutMoveIn")}
            className="ml-auto text-[11px] text-purple-700 hover:underline cursor-pointer">
            {side === "in" ? "→" : "←"}
          </button>
        )}
      </li>
    );
  };

  return (
    <InspectorSection title={t("layoutTemplateKey")} testId="editor-layout-template-key" aside={p.template.autoKey ?? undefined}>
      <div className="px-2.5 pb-2 space-y-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span data-testid="editor-layout-template-badge" data-auto-key={p.template.autoKey ?? ""} data-extra={p.template.isExtra ? "true" : "false"}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${p.template.isExtra ? "bg-amber-100 text-amber-800" : "bg-purple-100 text-purple-700"}`}>
            {p.template.isExtra ? t("layoutExtra") : t("layoutAuto")}
          </span>
          <span className="text-[11px] text-slate-500 truncate">{p.template.name}</span>
        </div>
        {p.canEdit && (
          <button type="button" data-testid="editor-layout-create-extra" onClick={() => void createExtra()}
            className="text-[11px] text-purple-700 hover:underline cursor-pointer">
            {t("layoutCreateExtra")}
          </button>
        )}
        <div onDragOver={(e) => e.preventDefault()} onDrop={drop("in")} data-testid="editor-layout-template-in"
          className="rounded border border-dashed border-slate-200 p-1">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 px-1">{t("layoutCoursesIn")}</p>
          <ul>{lists.inTemplate.map((c) => row(c, "in"))}</ul>
          {lists.inTemplate.length === 0 && <p className="px-1 text-[11px] text-slate-400">—</p>}
        </div>
        <div onDragOver={(e) => e.preventDefault()} onDrop={drop("out")} data-testid="editor-layout-template-others"
          className="rounded border border-dashed border-slate-200 p-1">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 px-1">{t("layoutCoursesOthers")}</p>
          <ul>{lists.others.map((c) => row(c, "out"))}</ul>
          {lists.others.length === 0 && <p className="px-1 text-[11px] text-slate-400">—</p>}
        </div>
      </div>
    </InspectorSection>
  );
}

function ScaleField({ value, testId, onCommit }: { value: number | null; testId: string; onCommit: (v: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = draft.trim() === "" ? null : Math.round(Number(draft));
    setDraft(null);
    if (n !== null && (!Number.isFinite(n) || n < 500 || n > 100_000)) return;
    if (n !== value) onCommit(n);
  };
  return (
    <input data-testid={testId} type="number" min={500} max={100000} step={500} placeholder="—" value={draft ?? (value === null ? "" : String(value))}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      className="w-20 px-1.5 py-0.5 border border-slate-200 rounded text-xs text-slate-700" />
  );
}

export function ClassOverridesSection(p: {
  courseSeq: number;
  canEdit: boolean;
  run: Run;
  record: Record_;
  onOpen: (t: LayoutTarget | null) => void;
}) {
  const { t } = useTranslation("editor");
  const utils = trpc.useUtils();
  const classes = trpc.layout.classOverrides.useQuery({ courseId: p.courseSeq });
  const templates = trpc.mapTemplate.list.useQuery();
  const rows = classes.data ?? [];
  if (rows.length === 0) return null;

  type Override = { printScale: number | null; sheetTemplateId: number | null };
  const set = async (classId: number, prev: Override, next: Override) => {
    const write = (o: Override) => async () => {
      await utils.client.layout.setClassOverride.mutate({ classId, ...o });
      void utils.layout.classOverrides.invalidate();
      void utils.courseMap.list.invalidate();
      void utils.courseMap.resolveSheet.invalidate();
      void utils.mapTemplate.list.invalidate();
      return true;
    };
    if ((await p.run(write(next))) !== undefined) p.record(write(prev), write(next));
  };

  return (
    <InspectorSection title={t("layoutClasses")} testId="editor-layout-classes">
      <div className="px-2.5 pb-2 space-y-1">
        <p className="text-[11px] text-slate-500">{t("layoutClassesHint")}</p>
        {rows.map((c) => {
          const prev = { printScale: c.printScale, sheetTemplateId: c.sheetTemplateSeq };
          return (
            <div key={c.seq} data-testid={`editor-layout-class-${c.seq}`} data-sheets={c.sheets.length} className="flex items-center gap-1 text-[11px] text-slate-600">
              <span className="w-12 truncate" title={c.name}>{c.name}</span>
              {p.canEdit ? (
                <>
                  <ScaleField value={c.printScale} testId={`editor-layout-class-scale-${c.seq}`} onCommit={(v) => void set(c.seq, prev, { ...prev, printScale: v })} />
                  <select data-testid={`editor-layout-class-template-${c.seq}`} value={c.sheetTemplateSeq ?? ""} aria-label={t("layoutClassTemplate")}
                    onChange={(e) => void set(c.seq, prev, { ...prev, sheetTemplateId: e.target.value === "" ? null : Number(e.target.value) })}
                    className="min-w-0 flex-1 px-1 py-0.5 border border-slate-200 rounded bg-white text-xs">
                    <option value="">{t("layoutClassTemplateAuto")}</option>
                    {(templates.data ?? []).map((x) => <option key={x.seq} value={x.seq}>{x.name}</option>)}
                  </select>
                </>
              ) : (
                <span className="flex-1">{c.printScale ? `1:${c.printScale}` : "—"}</span>
              )}
              {c.sheets.length > 0 && (
                <button type="button" data-testid={`editor-layout-class-open-${c.seq}`} onClick={() => p.onOpen({ sheet: c.sheets[0] })}
                  className="text-purple-700 hover:underline cursor-pointer">
                  {t("layoutOpen")}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </InspectorSection>
  );
}

export function ClubTemplatesSection(p: {
  /** The shown template (Save to club). */
  template: { seq: number; name: string };
  canEdit: boolean;
  run: Run;
  onOpen: (t: LayoutTarget | null) => void;
}) {
  const { t } = useTranslation("editor");
  const utils = trpc.useUtils();
  const club = trpc.mapTemplate.listClub.useQuery();
  const templates = trpc.mapTemplate.list.useQuery();
  const [notice, setNotice] = useState<string | null>(null);
  const rows = club.data ?? [];

  const bringIn = async (row: (typeof rows)[number]) => {
    const name = freeTemplateName(row.name, (templates.data ?? []).map((x) => x.name));
    const r = await p.run(async () => {
      const out = await utils.client.mapTemplate.loadFromClub.mutate({ clubTemplateId: row.id, name });
      await utils.mapTemplate.list.invalidate();
      return out;
    });
    if (!r) return;
    setNotice(null);
    p.onOpen({ template: r.template.seq });
  };
  const remove = async (row: (typeof rows)[number]) => {
    if (!window.confirm(t("layoutClubDeleteConfirm", { name: row.name }))) return;
    await p.run(async () => {
      await utils.client.mapTemplate.deleteClub.mutate({ id: row.id });
      await utils.mapTemplate.listClub.invalidate();
      return true;
    });
  };
  const save = async () => {
    const name = window.prompt(t("layoutClubName"), p.template.name)?.trim();
    if (!name) return;
    const done = await p.run(async () => {
      await utils.client.mapTemplate.saveToClub.mutate({ templateId: p.template.seq, name });
      await utils.mapTemplate.listClub.invalidate();
      return true;
    });
    if (done) setNotice(t("layoutClubSaved"));
  };

  return (
    <InspectorSection title={t("layoutClub")} testId="editor-layout-club" defaultOpen={false} aside={rows.length ? String(rows.length) : undefined}>
      <div className="px-2.5 pb-2 space-y-1">
        {notice && (
          <p data-testid="editor-layout-club-notice" className="flex items-start gap-1 text-[11px] text-amber-700">
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer" aria-label={t("dismiss")}>×</button>
          </p>
        )}
        {rows.length === 0 && <p className="text-[11px] text-slate-400">{t("layoutClubNone")}</p>}
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <li key={String(row.id)} data-testid={`editor-layout-club-row-${String(row.id)}`} className="flex items-center gap-1.5 text-[11px] text-slate-600">
              <span className="truncate flex-1" title={row.printScale ? `${row.paper ?? ""} ${row.orientation ?? ""} 1:${row.printScale}` : undefined}>{row.name}</span>
              {p.canEdit && (
                <>
                  <button type="button" data-testid={`editor-layout-club-import-${String(row.id)}`} title={t("layoutClubImportTitle", { name: row.name })}
                    onClick={() => void bringIn(row)} className="text-purple-700 hover:underline cursor-pointer">
                    {t("layoutClubImport")}
                  </button>
                  <button type="button" data-testid={`editor-layout-club-delete-${String(row.id)}`} aria-label={t("layoutClubDelete", { name: row.name })}
                    title={t("layoutClubDelete", { name: row.name })} onClick={() => void remove(row)} className="text-slate-400 hover:text-red-600 cursor-pointer">
                    ×
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {p.canEdit && (
          <button type="button" data-testid="editor-layout-save-to-club" onClick={() => void save()} className="text-[11px] text-purple-700 hover:underline cursor-pointer">
            {t("layoutClubSave")}
          </button>
        )}
      </div>
    </InspectorSection>
  );
}
