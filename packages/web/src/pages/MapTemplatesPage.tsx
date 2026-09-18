import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { MapLayoutEditor, type MapLayoutSnapshot } from "../components/MapLayoutEditor";
import { SortHeader } from "../components/SortHeader";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useCapabilities } from "../context/CapabilitiesContext";
import { useNumericSearchParam } from "../hooks/useSearchParam";
import { useSort } from "../hooks/useSort";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import {
  draftFromTemplate,
  EMPTY_TEMPLATE_DRAFT,
  templatePayload,
  type MapTemplateView,
  type TemplateDraft,
  type TemplateLayoutPreview,
} from "../lib/course-map-types";
import {
  createMapTemplateAnchors,
  type MapTemplateSearchRow,
} from "../lib/structured-search/anchors/map-template-anchors";
import { trpc } from "../lib/trpc";
import {
  courseMapObjectPageBounds,
  getPaperDimensions,
  rectInside,
} from "@oxygen/shared";

/**
 * Page-anchored template objects outside the printable margin. Map-anchored
 * objects are excluded: they are clipped to the map frame when printed.
 */
function templateIssueCount(row: MapTemplateView): number {
  const paper = getPaperDimensions(
    row.paper as Parameters<typeof getPaperDimensions>[0],
    row.orientation as Parameters<typeof getPaperDimensions>[1],
    row.paper === "custom" && row.paperWidthMm && row.paperHeightMm
      ? { width: row.paperWidthMm, height: row.paperHeightMm }
      : undefined,
  );
  const margin = row.settings.printMarginMm;
  const printable = {
    x: margin,
    y: margin,
    width: Math.max(0.001, paper.width - margin * 2),
    height: Math.max(0.001, paper.height - margin * 2),
  };
  return row.objects.filter((object) => {
    if (object.anchor !== "page") return false;
    const bounds = courseMapObjectPageBounds(object, row.settings.mapFrame);
    return bounds !== null && !rectInside(bounds, printable);
  }).length;
}

type TemplateRow = MapTemplateView & MapTemplateSearchRow;

export function MapTemplatesPage() {
  const { t } = useTranslation("maps");
  const { nameId = "" } = useParams<{ nameId: string }>();
  const { has } = useCapabilities();
  const canEdit = has("courses.edit");
  const utils = trpc.useUtils();
  const templates = trpc.mapTemplate.list.useQuery();
  const maps = trpc.courseMap.list.useQuery();
  const courses = trpc.course.list.useQuery();
  const clubTemplates = trpc.mapTemplate.listClub.useQuery();
  const rows = useMemo<TemplateRow[]>(
    () =>
      ((templates.data ?? []) as MapTemplateView[]).map((template) => ({
        ...template,
        usedBy: (maps.data ?? []).filter(
          (map) => map.templateId === template.seq,
        ).length,
      })),
    [maps.data, templates.data],
  );
  const searchAnchors = useMemo(
    () => createMapTemplateAnchors<TemplateRow>((key) => t(key as never)),
    [t],
  );
  const { tokens, setTokens, filterItems } =
    useStructuredSearch<TemplateRow>(searchAnchors, ["name"]);
  const filteredRows = useMemo(
    () => filterItems(rows),
    [filterItems, rows],
  );
  const { sorted, sort, toggle } = useSort(
    filteredRows,
    { key: "name", dir: "asc" },
    useMemo(
      () => ({
        name: (a: MapTemplateView, b: MapTemplateView) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        scale: (a: MapTemplateView, b: MapTemplateView) =>
          a.printScale - b.printScale,
      }),
      [],
    ),
  );
  const [expandedSeq, setExpandedSeq] = useNumericSearchParam("template");
  const [drafts, setDrafts] = useState<Record<number, TemplateDraft>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [showClubImport, setShowClubImport] = useState(false);
  const [createDraft, setCreateDraft] = useState<TemplateDraft>(
    EMPTY_TEMPLATE_DRAFT,
  );
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [previewCourseId, setPreviewCourseId] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const editingTemplate = rows.find((row) => row.seq === editingSeq);
  const preview = trpc.mapTemplate.previewLayout.useQuery(
    {
      id: editingSeq ?? 1,
      ...(previewCourseId === undefined ? {} : { courseId: previewCourseId }),
    },
    { enabled: editingSeq !== null },
  );

  const invalidate = () =>
    Promise.all([
      utils.mapTemplate.list.invalidate(),
      utils.mapTemplate.listClub.invalidate(),
      utils.courseMap.list.invalidate(),
    ]);
  const mutationOptions = {
    onSuccess: () => void invalidate(),
    onError: (cause: { message: string }) => setError(cause.message),
  };
  const createTemplate = trpc.mapTemplate.create.useMutation(mutationOptions);
  const updateTemplate = trpc.mapTemplate.update.useMutation(mutationOptions);
  const duplicateTemplate =
    trpc.mapTemplate.duplicate.useMutation(mutationOptions);
  const deleteTemplate = trpc.mapTemplate.delete.useMutation(mutationOptions);
  const saveToClub = trpc.mapTemplate.saveToClub.useMutation(mutationOptions);
  const loadFromClub =
    trpc.mapTemplate.loadFromClub.useMutation(mutationOptions);
  const deleteClub = trpc.mapTemplate.deleteClub.useMutation(mutationOptions);

  const openRow = (row: MapTemplateView) => {
    setDrafts((current) => ({
      ...current,
      [row.seq]: current[row.seq] ?? draftFromTemplate(row),
    }));
    setExpandedSeq(expandedSeq === row.seq ? undefined : row.seq);
  };

  const saveDraft = async (row: MapTemplateView) => {
    const draft = drafts[row.seq] ?? draftFromTemplate(row);
    if (!draft.name.trim()) return;
    await updateTemplate.mutateAsync({
      id: row.seq,
      ...templatePayload(draft, row),
    });
  };

  const openEditor = (row: MapTemplateView) => {
    const firstCourse = (courses.data ?? [])[0];
    setPreviewCourseId(firstCourse?.id);
    setEditingSeq(row.seq);
  };

  const saveLayout = async (snapshot: MapLayoutSnapshot) => {
    if (!editingTemplate) return;
    await updateTemplate.mutateAsync({
      id: editingTemplate.seq,
      printScale: snapshot.printScale,
      settings: {
        ...editingTemplate.settings,
        description: snapshot.description,
      },
      objects: snapshot.templateObjects,
    });
  };

  return (
    <div data-testid="map-templates-page">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row">
        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={searchAnchors}
          placeholder={t("searchTemplatesPlaceholder")}
        />
        {canEdit && (
          <button
            type="button"
            data-testid="import-club-templates"
            onClick={() => setShowClubImport(true)}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {t("importFromClub")}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            data-testid="new-map-template"
            onClick={() => {
              setCreateDraft(EMPTY_TEMPLATE_DRAFT);
              setShowCreate(true);
            }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t("newTemplate")}
          </button>
        )}
      </div>

      <div className="mb-3 text-sm text-slate-500">
        {t("templateCount", { count: sorted.length })}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {importNotice && (
        <div
          role="status"
          data-testid="map-template-import-notice"
          className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <span>{importNotice}</span>
          <button
            type="button"
            onClick={() => setImportNotice(null)}
            className="shrink-0 font-medium text-amber-800 hover:underline"
          >
            {t("dismiss")}
          </button>
        </div>
      )}

      {showCreate && (
        <div
          data-testid="map-template-form"
          className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-4"
        >
          <TemplateFields
            draft={createDraft}
            onChange={setCreateDraft}
            t={t}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              data-testid="map-template-submit"
              onClick={() => {
                const payload = templatePayload(createDraft);
                if (!payload.name) {
                  setError(t("nameRequired"));
                  return;
                }
                void createTemplate.mutateAsync(payload).then((created) => {
                  setShowCreate(false);
                  setExpandedSeq(created.seq);
                });
              }}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white"
            >
              {t("createTemplate")}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <SortHeader
                label={t("templateName")}
                active={sort.key === "name"}
                direction={sort.dir}
                onClick={() => toggle("name")}
              />
              <th className="px-4 py-2.5 text-left font-medium text-slate-500">
                {t("paper")}
              </th>
              <SortHeader
                label={t("printScale")}
                active={sort.key === "scale"}
                direction={sort.dir}
                onClick={() => toggle("scale")}
              />
              <th className="px-4 py-2.5 text-right font-medium text-slate-500">
                {t("usedBy")}
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-500">
                {t("status")}
              </th>
              <th className="px-4 py-2.5 text-right font-medium text-slate-500">
                {t("actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((row) => {
              const draft = drafts[row.seq] ?? draftFromTemplate(row);
              return (
                <Fragment key={row.id}>
                  <tr
                    data-testid={`map-template-${row.seq}`}
                    onClick={() => openRow(row)}
                    className={
                      expandedSeq === row.seq
                        ? "cursor-pointer bg-blue-50"
                        : "cursor-pointer hover:bg-slate-50"
                    }
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {row.name}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.paper} ·{" "}
                      {t(
                        row.orientation === "landscape"
                          ? "landscape"
                          : "portrait",
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">
                      1:{row.printScale}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {row.usedBy}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const issues = templateIssueCount(row);
                        return issues === 0 ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                            {t("valid")}
                          </span>
                        ) : (
                          <span
                            data-testid={`map-template-status-${row.seq}`}
                            title={t("objectOutsidePage")}
                            className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                          >
                            {t("issuesCount", { count: issues })}
                          </span>
                        );
                      })()}
                    </td>
                    <td
                      className="px-4 py-3"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="flex justify-end gap-0.5">
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              data-testid={`edit-template-layout-${row.seq}`}
                              onClick={() => openEditor(row)}
                              title={t("editLayout")}
                              className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-700"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15H9v-2.8l8.6-8.6z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              data-testid={`duplicate-map-template-${row.seq}`}
                              onClick={() => {
                                const name = window.prompt(
                                  t("duplicateTemplateName"),
                                  `${row.name} copy`,
                                );
                                if (name?.trim()) {
                                  void duplicateTemplate.mutateAsync({
                                    id: row.seq,
                                    name: name.trim(),
                                  });
                                }
                              }}
                              title={t("duplicateTemplate")}
                              className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-700"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a2 2 0 012-2h7a2 2 0 012 2v7a2 2 0 01-2 2h-2m-7-7H5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3M8 7h5a2 2 0 012 2v5" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              data-testid={`save-template-to-club-${row.seq}`}
                              onClick={() => {
                                const name = window.prompt(
                                  t("clubTemplateName"),
                                  row.name,
                                );
                                if (name?.trim()) {
                                  void saveToClub.mutateAsync({
                                    templateId: row.seq,
                                    name: name.trim(),
                                  });
                                }
                              }}
                              title={t("saveToClub")}
                              className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-700"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 16V4m0 0L8 8m4-4l4 4M5 14v5h14v-5" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              data-testid={`delete-map-template-${row.seq}`}
                              onClick={() => {
                                if (window.confirm(t("deleteTemplateConfirm", { name: row.name }))) {
                                  void deleteTemplate.mutateAsync({ id: row.seq });
                                }
                              }}
                              title={t("deleteTemplate")}
                              className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                            >
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.9 12.1A2 2 0 0116.1 21H7.9a2 2 0 01-2-1.9L5 7m5 4v6m4-6v6m1-10V4H9v3M4 7h16" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedSeq === row.seq && (
                    <tr>
                      <td colSpan={6} className="bg-blue-50/60 p-5">
                        <TemplateFields
                          draft={draft}
                          onChange={(next) =>
                            setDrafts((current) => ({
                              ...current,
                              [row.seq]: next,
                            }))
                          }
                          onBlur={() => void saveDraft(row)}
                          t={t}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
        {sorted.length === 0 && !templates.isLoading && (
          <p className="p-8 text-center text-sm text-slate-400">
            {t("noTemplates")}
          </p>
        )}
      </div>

      {showClubImport && (
        <ClubTemplateImportDialog
          templates={clubTemplates.data ?? []}
          pending={loadFromClub.isPending || deleteClub.isPending}
          onImport={(row) =>
            void loadFromClub
              .mutateAsync({ clubTemplateId: row.id, name: row.name })
              .then((result) => {
                setShowClubImport(false);
                if (result.removedMapAnchoredCount > 0) {
                  setImportNotice(
                    t("mapAnchoredObjectsRemoved", {
                      count: result.removedMapAnchoredCount,
                    }),
                  );
                }
              })
          }
          onDelete={(row) => void deleteClub.mutateAsync({ id: row.id })}
          onClose={() => setShowClubImport(false)}
        />
      )}

      {editingTemplate &&
        preview.data &&
        (() => {
          const data = preview.data as TemplateLayoutPreview;
          return (
            <MapLayoutEditor
              key={editingTemplate.seq}
              mode="template"
              nameId={nameId}
              mapName={editingTemplate.name}
              document={data.document}
              window={data.window}
              controls={data.controls}
              legs={data.legs}
              descriptionRows={data.descriptionRows}
              descriptionTitle={data.textValues.course || editingTemplate.name}
              mapObjects={[]}
              templateObjects={editingTemplate.objects}
              textValues={data.textValues}
              previewCourses={(courses.data ?? []).map((course) => ({
                id: course.id,
                name: course.name,
              }))}
              previewCourseId={previewCourseId}
              onPreviewCourseChange={setPreviewCourseId}
              onSave={saveLayout}
              onClose={() => setEditingSeq(null)}
            />
          );
        })()}
    </div>
  );
}

interface ClubTemplateRow {
  id: bigint;
  name: string;
  paper: string | null;
  orientation: string | null;
  printScale: number | null;
}

function ClubTemplateImportDialog({
  templates,
  pending,
  onImport,
  onDelete,
  onClose,
}: {
  templates: ClubTemplateRow[];
  pending: boolean;
  onImport: (template: ClubTemplateRow) => void;
  onDelete: (template: ClubTemplateRow) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("maps");
  return (
    <div
      data-testid="club-template-import-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("importFromClub")}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-label={t("close")}
      />
      <div className="relative max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="font-semibold text-slate-900">
            {t("importFromClub")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100"
            title={t("close")}
          >
            ×
          </button>
        </div>
        {templates.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-400">
            {t("noClubTemplates")}
          </p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium text-slate-500">
                    {t("templateName")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-slate-500">
                    {t("paper")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-slate-500">
                    {t("printScale")}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium text-slate-500">
                    {t("actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {templates.map((row) => (
                  <tr key={String(row.id)}>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {row.name}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.paper ?? "—"}
                      {row.orientation
                        ? ` · ${t(row.orientation as "portrait" | "landscape")}`
                        : ""}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.printScale ? `1:${row.printScale}` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-0.5">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => onImport(row)}
                          title={t("loadFromClub")}
                          className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-40"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v12m0 0l-4-4m4 4l4-4M5 19h14" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => onDelete(row)}
                          title={t("deleteClubTemplate")}
                          className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.9 12.1A2 2 0 0116.1 21H7.9a2 2 0 01-2-1.9L5 7m5 4v6m4-6v6m1-10V4H9v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateFields({
  draft,
  onChange,
  onBlur,
  t,
}: {
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  onBlur?: () => void;
  t: ReturnType<typeof useTranslation<"maps">>["t"];
}) {
  const update = <K extends keyof TemplateDraft>(
    key: K,
    value: TemplateDraft[K],
  ) => onChange({ ...draft, [key]: value });
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <label className="text-xs font-medium text-slate-600">
        {t("templateName")}
        <input
          data-testid="map-template-name"
          value={draft.name}
          onChange={(event) => update("name", event.target.value)}
          onBlur={onBlur}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500"
        />
      </label>
      <label className="text-xs font-medium text-slate-600">
        {t("paper")}
        <select
          data-testid="map-template-paper"
          value={draft.paper}
          onChange={(event) =>
            update("paper", event.target.value as TemplateDraft["paper"])
          }
          onBlur={onBlur}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
        >
          <option value="A3">A3</option>
          <option value="A4">A4</option>
          <option value="A5">A5</option>
        </select>
      </label>
      <label className="text-xs font-medium text-slate-600">
        {t("orientation")}
        <select
          value={draft.orientation}
          onChange={(event) =>
            update(
              "orientation",
              event.target.value as TemplateDraft["orientation"],
            )
          }
          onBlur={onBlur}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
        >
          <option value="portrait">{t("portrait")}</option>
          <option value="landscape">{t("landscape")}</option>
        </select>
      </label>
      <label className="text-xs font-medium text-slate-600">
        {t("printScale")}
        <input
          data-testid="map-template-scale"
          type="number"
          list="map-common-scales"
          value={draft.printScale}
          onChange={(event) => update("printScale", event.target.value)}
          onBlur={onBlur}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm tabular-nums"
        />
      </label>
      <label className="text-xs font-medium text-slate-600">
        {t("margin")}
        <input
          type="number"
          value={draft.margin}
          onChange={(event) => update("margin", event.target.value)}
          onBlur={onBlur}
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm tabular-nums"
        />
      </label>
      <datalist id="map-common-scales">
        <option value="4000" />
        <option value="5000" />
        <option value="7500" />
        <option value="10000" />
        <option value="15000" />
      </datalist>
    </div>
  );
}
