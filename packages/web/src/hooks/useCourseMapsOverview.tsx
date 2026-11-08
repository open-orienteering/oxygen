/**
 * The Courses page's print overview (E-pages; docs/course-maps.md "Where
 * sheets and templates are managed"): per course its own sheets' template,
 * print status and first sheet; applying a template pick (an event
 * template, a club template brought in, or a new one through the dialog);
 * the map exports, each ensuring its sheets first under `courses.edit`.
 * The cells are in `components/CourseMapsOverview.tsx`.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { downloadSameOriginFile } from "../lib/download-api";
import { freeTemplateName, type TemplatePick } from "../lib/template-picker";
import type { CoursePrintStatus } from "../lib/structured-search/anchors/course-anchors";
import { NewTemplateForm } from "../components/NewTemplateForm";

export interface CourseSheetInfo {
  /** The course's first own sheet with a template (Edit layout). */
  sheetSeq: number | null;
  template: { seq: number; name: string; autoKey: string | null; isExtra: boolean } | null;
  templateNames: string[];
  printStatus: CoursePrintStatus;
  issueCount: number;
}

const NO_SHEETS: CourseSheetInfo = { sheetSeq: null, template: null, templateNames: [], printStatus: "noMap", issueCount: 0 };

export function useCourseMapsOverview(nameId: string, canEdit: boolean) {
  const { t } = useTranslation("courses");
  const utils = trpc.useUtils();
  const maps = trpc.courseMap.list.useQuery();
  const templates = trpc.mapTemplate.list.useQuery();
  const club = trpc.mapTemplate.listClub.useQuery(undefined, { enabled: canEdit });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** "New template…" was picked for these courses: the dialog is open. */
  const [newFor, setNewFor] = useState<number[] | null>(null);

  const byCourse = useMemo(() => {
    const out = new Map<number, CourseSheetInfo>();
    const own = (maps.data ?? [])
      .filter((m) => m.kind === "course" && m.class === null && m.courseId !== null)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.seq - b.seq);
    const grouped = new Map<number, typeof own>();
    for (const m of own) {
      const list = grouped.get(m.courseId!);
      if (list) list.push(m);
      else grouped.set(m.courseId!, [m]);
    }
    for (const [courseId, sheets] of grouped) {
      const first = sheets.find((s) => s.template !== null);
      const issueCount = sheets.reduce((n, s) => n + s.validation.issues.length, 0);
      out.set(courseId, {
        sheetSeq: first?.seq ?? null,
        template: first?.template ?? null,
        templateNames: [...new Set(sheets.flatMap((s) => (s.template ? [s.template.name] : [])))],
        printStatus: sheets.some((s) => !s.validation.valid) ? "issues" : "ready",
        issueCount,
      });
    }
    return out;
  }, [maps.data]);

  const info = useCallback((courseId: number): CourseSheetInfo => byCourse.get(courseId) ?? NO_SHEETS, [byCourse]);

  const refresh = () =>
    Promise.all([utils.courseMap.list.invalidate(), utils.mapTemplate.list.invalidate(), utils.layout.classOverrides.invalidate()]);

  const guarded = async <T,>(op: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await op();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("downloadFailed"));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const applySeq = async (templateId: number, courseIds: number[]) => {
    await utils.client.mapTemplate.applyToCourses.mutate({ templateId, courseIds });
    await refresh();
  };

  /** Apply a pick to courses; "New template…" opens the dialog. Answers true when it was applied. */
  const apply = async (pick: TemplatePick, courseIds: number[]): Promise<boolean> => {
    if (courseIds.length === 0) return false;
    if (pick.kind === "new") {
      setNewFor(courseIds);
      return false;
    }
    const done = await guarded(async () => {
      let seq: number;
      if (pick.kind === "club") {
        const row = (club.data ?? []).find((c) => String(c.id) === pick.id);
        if (!row) throw new Error(t("downloadFailed"));
        const name = freeTemplateName(row.name, (templates.data ?? []).map((x) => x.name));
        const r = await utils.client.mapTemplate.loadFromClub.mutate({ clubTemplateId: row.id, name });
        if (r.removedMapAnchoredCount > 0) setNotice(t("mapAnchoredObjectsRemoved", { count: r.removedMapAnchoredCount }));
        seq = r.template.seq;
      } else seq = pick.seq;
      await applySeq(seq, courseIds);
      return true;
    });
    return done === true;
  };

  const download = (query: string) => downloadSameOriginFile(`/api/maps/${encodeURIComponent(nameId)}/maps.pdf${query}`);

  /** One course's maps; with courses.edit a course without a sheet gets one on its key's auto template first (docs/course-layout.md §6, §7). */
  const exportCourse = (courseId: number) =>
    guarded(async () => {
      if (canEdit) {
        await utils.client.layout.autoSheets.mutate({ courseId });
        await refresh();
      }
      await download(`?courses=${courseId}`);
    });
  /** One variant of a root, on the root's sheets (F8; course-print.md §4.6): the root's sheets are ensured first. */
  const exportVariant = (rootId: number, key: string) =>
    guarded(async () => {
      if (canEdit) {
        await utils.client.layout.autoSheets.mutate({ courseId: rootId });
        await refresh();
      }
      await download(`?${new URLSearchParams({ variants: `${rootId}:${key}` })}`);
    });
  /** A root's all-variations page for officials (F8; answer 4). */
  const exportAllVariations = (rootId: number) =>
    guarded(async () => {
      if (canEdit) {
        await utils.client.layout.autoSheets.mutate({ courseId: rootId });
        await refresh();
      }
      await download(`?allVariations=${rootId}`);
    });
  const exportAll = () =>
    guarded(async () => {
      if (canEdit) {
        await utils.client.layout.autoSheets.mutate({});
        await refresh();
      }
      await download("");
    });
  const exportAllControls = () =>
    guarded(async () => {
      if (canEdit) {
        await utils.client.layout.autoSheets.mutate({ allControls: true });
        await refresh();
      }
      await download("?allControls=1");
    });

  const dialog: ReactNode = newFor ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setNewFor(null)}>
      <div role="dialog" aria-modal="true" aria-label={t("newTemplateTitle")} data-testid="new-template-dialog"
        className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("newTemplateTitle")}</h2>
        <NewTemplateForm busy={busy} onCancel={() => setNewFor(null)}
          onSubmit={(payload) => {
            const courseIds = newFor;
            void guarded(async () => {
              const row = await utils.client.mapTemplate.create.mutate(payload);
              await applySeq(row.seq, courseIds);
              setNewFor(null);
            });
          }} />
        {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  ) : null;

  const messages: ReactNode = (
    <>
      {error && !newFor && (
        <div role="alert" data-testid="course-maps-error" className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="cursor-pointer text-red-400 hover:text-red-600">{t("dismiss")}</button>
        </div>
      )}
      {notice && (
        <div data-testid="course-maps-notice" className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="cursor-pointer text-amber-500 hover:text-amber-700">{t("dismiss")}</button>
        </div>
      )}
    </>
  );

  return {
    info,
    templates: templates.data ?? [],
    club: club.data ?? [],
    busy,
    apply,
    exportCourse,
    exportVariant,
    exportAllVariations,
    exportAll,
    exportAllControls,
    dialog,
    messages,
  };
}
