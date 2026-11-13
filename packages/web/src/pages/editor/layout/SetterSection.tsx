/**
 * Layout mode's *Setter maps* section (docs/course-layout.md §8; research
 * 08 §4.6 "Setter maps"; F10):
 *
 * - the scope — every placed control of the event in view All (or without
 *   a course), else the top bar's course (`setterScopeOf`);
 * - a number of setters and *Generate* / *Regenerate*
 *   (`layout.setterMaps`; regenerating replaces the scope's setter maps
 *   after a confirm) — not an undo entry, as a sheet's create / delete;
 * - the scope's setter sheets, *Setter 1 … n*, each opening its sheet;
 * - with a setter sheet open, its controls in code order, each with
 *   **Move to next setter** (`layout.moveToSetter`, the next sheet in
 *   setter order, the last's next the first): one undo entry, undo moves
 *   it back; the windows stay until *Recalculate* (`SheetActions`).
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { displayCode } from "@oxygen/shared";
import { trpc } from "../../../lib/trpc";
import type { VersionBook } from "../../../lib/version-book";
import type { EditorView } from "../../../lib/editor/state";
import { nextSetterSheet, setterScopeOf, setterSheetsOf, type SetterSheetRow } from "../../../lib/editor/setter-maps";
import { InspectorSection } from "../Inspector";
import type { LayoutTarget } from "./bindings";
import { useRefresh, type Record_, type Run } from "./refresh";

const LINK = "text-[11px] text-purple-700 hover:underline cursor-pointer disabled:opacity-40 disabled:no-underline disabled:cursor-default";

export function SetterSection(p: {
  view: EditorView;
  course: { id: number; name: string } | null;
  /** `courseMap.list`. */
  rows: readonly SetterSheetRow[];
  /** The shown sheet (its seq), null without one. */
  openSheet: number | null;
  canEdit: boolean;
  versions: VersionBook;
  run: Run;
  record: Record_;
  onOpen: (t: LayoutTarget | null) => void;
}) {
  const { t } = useTranslation("editor");
  const client = trpc.useUtils().client;
  const refresh = useRefresh();
  const controls = trpc.control.list.useQuery();
  const scope = setterScopeOf(p.view, p.course);
  const sheets = useMemo(() => setterSheetsOf(p.rows, scope), [p.rows, scope]);
  const [groups, setGroups] = useState<number | null>(null);
  const count = groups ?? (sheets.length || 2);
  const open = p.rows.find((r) => r.seq === p.openSheet && r.kind === "setter" && r.setter) ?? null;
  const openScope = useMemo(() => (open ? setterSheetsOf(p.rows, open.courseId) : []), [p.rows, open]);
  const codeOf = useMemo(() => {
    const m = new Map((controls.data ?? []).map((c) => [c.id, displayCode({ codes: c.codes, name: c.name, seq: c.id, kind: c.kind })]));
    return (id: number) => m.get(id) ?? String(id);
  }, [controls.data]);

  const generate = async () => {
    if (sheets.length > 0 && !window.confirm(t("layoutSetterRegenerateConfirm", { count: sheets.length }))) return;
    await p.run(async () => {
      const r = await client.layout.setterMaps.mutate({ ...(scope !== null ? { courseId: scope } : {}), groups: count });
      await refresh(true);
      p.onOpen(r.sheets[0] ? { sheet: r.sheets[0].seq } : null);
      return r;
    });
  };

  const move = async (controlId: number) => {
    if (!open) return;
    const next = nextSetterSheet(openScope, open.seq);
    if (!next) return;
    const to = (sheet: number) => async () => {
      const r = await client.layout.moveToSetter.mutate({ controlId, sheet });
      for (const s of r.sheets) p.versions.seed("sheet", s.seq, s.version);
      await refresh();
      return true;
    };
    if ((await p.run(to(next.seq))) !== undefined) p.record(to(open.seq), to(next.seq));
  };

  const nextIndex = open ? nextSetterSheet(openScope, open.seq)?.setter?.index ?? null : null;
  return (
    <InspectorSection title={t("layoutSetter")} testId="editor-layout-setter" defaultOpen={sheets.length > 0 || p.view === "all"}>
      <div className="px-2.5 pb-2 space-y-1.5" data-scope={scope ?? "event"}>
        <p className="text-[11px] text-slate-500" data-testid="editor-layout-setter-scope">
          {scope === null ? t("layoutSetterScopeEvent") : t("layoutSetterScopeCourse", { course: p.course?.name ?? "" })}
        </p>
        {p.canEdit && (
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-slate-600">
              {t("layoutSetterGroups")}
              <input type="number" min={1} max={20} step={1} value={count} data-testid="editor-layout-setter-groups"
                onChange={(e) => { const v = Math.round(Number(e.target.value)); if (Number.isFinite(v)) setGroups(Math.max(1, Math.min(20, v))); }}
                className="w-12 px-1 py-0.5 border border-slate-200 rounded bg-white tabular-nums" />
            </label>
            <button type="button" data-testid="editor-layout-setter-generate" onClick={() => void generate()} className={LINK}>
              {sheets.length > 0 ? t("layoutSetterRegenerate") : t("layoutSetterGenerate")}
            </button>
          </div>
        )}
        {sheets.length === 0 ? (
          <p className="text-[11px] text-slate-400" data-testid="editor-layout-setter-none">{t("layoutSetterNone")}</p>
        ) : (
          <ul className="space-y-0.5">
            {sheets.map((s) => (
              <li key={s.seq}>
                <button type="button" data-testid="editor-layout-setter-row" data-setter={s.setter!.index} data-sheet={s.seq}
                  aria-current={s.seq === p.openSheet ? "true" : undefined}
                  onClick={() => p.onOpen({ sheet: s.seq })}
                  className={`w-full text-left px-1.5 py-0.5 rounded text-[11px] cursor-pointer ${s.seq === p.openSheet ? "bg-purple-50 text-purple-800" : "text-slate-700 hover:bg-slate-50"}`}>
                  {t("layoutSetterRow", { n: s.setter!.index, count: s.setter!.controls.length })}
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && (
          <div className="pt-1 border-t border-slate-100" data-testid="editor-layout-setter-controls" data-sheet={open.seq}>
            <p className="text-[11px] text-slate-500 pb-0.5">{t("layoutSetterControls")}</p>
            <ul className="space-y-0.5">
              {open.setter!.controls.map((id) => (
                <li key={id} data-testid="editor-layout-setter-control" data-control-id={id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-10 font-medium text-slate-700 truncate">{codeOf(id)}</span>
                  {p.canEdit && (
                    <button type="button" data-testid="editor-layout-setter-move" disabled={nextIndex === null}
                      title={nextIndex === null ? undefined : t("layoutSetterMoveTitle", { code: codeOf(id), n: nextIndex })}
                      onClick={() => void move(id)} className={LINK}>
                      {t("layoutSetterMove")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </InspectorSection>
  );
}
