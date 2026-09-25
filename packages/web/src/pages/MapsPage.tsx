import { Fragment, useMemo, useState } from "react";
import type { ClassSummary } from "@oxygen/shared";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { BulkActionBar } from "../components/BulkActionBar";
import { MapLayoutEditor, type MapLayoutSnapshot } from "../components/MapLayoutEditor";
import { SortHeader } from "../components/SortHeader";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useCapabilities } from "../context/CapabilitiesContext";
import { useNumericSearchParam } from "../hooks/useSearchParam";
import { useSort } from "../hooks/useSort";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import { useTableSelection } from "../hooks/useTableSelection";
import {
  type CourseMapView,
  type MapTemplateView,
} from "../lib/course-map-types";
import { downloadSameOriginFile } from "../lib/download-api";
import {
  createCourseMapAnchors,
  type CourseMapSearchRow,
} from "../lib/structured-search/anchors/course-map-anchors";
import { trpc } from "../lib/trpc";

interface RawCourseRow {
  id: number;
  name: string;
}

interface CourseRow extends CourseMapSearchRow {
  classes?: Array<{ name: string }>;
}

export function MapsPage() {
  const { t } = useTranslation("maps");
  const { nameId = "" } = useParams<{ nameId: string }>();
  const { has } = useCapabilities();
  const canEdit = has("courses.edit");
  const utils = trpc.useUtils();
  const coursesQuery = trpc.course.list.useQuery();
  const classesQuery = trpc.class.list.useQuery();
  const mapsQuery = trpc.courseMap.list.useQuery();
  const templatesQuery = trpc.mapTemplate.list.useQuery();
  const courses = useMemo(
    () => (coursesQuery.data ?? []) as RawCourseRow[],
    [coursesQuery.data],
  );
  const maps = useMemo(
    () => (mapsQuery.data ?? []) as CourseMapView[],
    [mapsQuery.data],
  );
  const templates = useMemo(
    () => (templatesQuery.data ?? []) as MapTemplateView[],
    [templatesQuery.data],
  );
  const mapsByCourse = useMemo(() => {
    const grouped = new Map<number, CourseMapView[]>();
    for (const map of maps) {
      if (map.courseId === null) continue;
      const rows = grouped.get(map.courseId);
      if (rows) rows.push(map);
      else grouped.set(map.courseId, [map]);
    }
    return grouped;
  }, [maps]);
  const courseRows = useMemo<CourseRow[]>(
    () =>
      courses.map((course) => {
        const courseMaps = mapsByCourse.get(course.id) ?? [];
        const classes = ((classesQuery.data ?? []) as ClassSummary[])
          .filter((item) => item.courseIds.includes(course.id))
          .map((item) => ({ name: item.name }));
        return {
          ...course,
          classes,
          classNames: classes.map((item) => item.name),
          templateNames: courseMaps.flatMap((map) =>
            map.template ? [map.template.name] : [],
          ),
          status:
            courseMaps.length === 0
              ? "noMap"
              : courseMaps.some((map) => !map.validation.valid)
                ? "issues"
                : "ready",
          mapCount: courseMaps.length,
        };
      }),
    [classesQuery.data, courses, mapsByCourse],
  );
  const searchAnchors = useMemo(
    () =>
      createCourseMapAnchors<CourseRow>(
        (key) => t(key as never),
        templates.map((template) => template.name),
      ),
    [t, templates],
  );
  const { tokens, setTokens, filterItems } =
    useStructuredSearch<CourseRow>(searchAnchors, ["name"]);
  const filteredCourses = useMemo(
    () => filterItems(courseRows),
    [courseRows, filterItems],
  );
  const { sorted, sort, toggle } = useSort(
    filteredCourses,
    { key: "name", dir: "asc" },
    useMemo(
      () => ({
        name: (a: CourseRow, b: CourseRow) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        maps: (a: CourseRow, b: CourseRow) =>
          (mapsByCourse.get(a.id)?.length ?? 0) -
          (mapsByCourse.get(b.id)?.length ?? 0),
      }),
      [mapsByCourse],
    ),
  );
  const selection = useTableSelection(sorted);
  const [expandedId, setExpandedId] = useNumericSearchParam("course");
  const [bulkTemplate, setBulkTemplate] = useState<number | null>(null);
  const [editingMapSeq, setEditingMapSeq] = useState<number | null>(null);
  const [addingForCourse, setAddingForCourse] = useState<number | null>(null);
  const [addTemplateSeq, setAddTemplateSeq] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    Promise.all([
      utils.courseMap.list.invalidate(),
      utils.mapTemplate.list.invalidate(),
    ]);
  const mutationOptions = {
    onSuccess: () => void invalidate(),
    onError: (cause: { message: string }) => setError(cause.message),
  };
  const applyTemplate =
    trpc.mapTemplate.applyToCourses.useMutation(mutationOptions);
  const createMap = trpc.courseMap.create.useMutation(mutationOptions);
  const updateMap = trpc.courseMap.update.useMutation(mutationOptions);
  const saveMapLayout = trpc.courseMap.saveLayout.useMutation(mutationOptions);
  const deleteMap = trpc.courseMap.delete.useMutation(mutationOptions);
  const editingMap = maps.find((map) => map.seq === editingMapSeq);
  const allControls = maps.filter((map) => map.kind === "all_controls");

  const exportPdf = async (params: URLSearchParams) => {
    setExportOpen(false);
    try {
      await downloadSameOriginFile(
        `/api/maps/${encodeURIComponent(nameId)}/maps.pdf?${params}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("downloadFailed"));
    }
  };

  const saveLayout = async (snapshot: MapLayoutSnapshot) => {
    if (!editingMap) return;
    await saveMapLayout.mutateAsync({
      id: editingMap.seq,
      windowCenter: snapshot.center,
      printScale: snapshot.printScale,
      description: snapshot.description,
      objects: snapshot.objects,
      templateObjects: snapshot.templateObjects,
    });
    await utils.courseMap.list.invalidate();
  };

  return (
    <div data-testid="maps-page">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row">
        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={searchAnchors}
          placeholder={t("searchMapsPlaceholder")}
        />
          {canEdit && (
            <button
              type="button"
              data-testid="add-all-controls-map"
              disabled={templates.length === 0 || allControls.length > 0}
              onClick={() => {
                const template = templates[0];
                if (!template) return;
                void createMap.mutateAsync({
                  kind: "all_controls",
                  courseId: null,
                  templateId: template.seq,
                  overrides: {},
                  objects: [],
                });
              }}
              className="rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-40"
            >
              {t("addAllControlsMap")}
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              data-testid="maps-export-menu"
              disabled={maps.length === 0}
              onClick={() => setExportOpen((current) => !current)}
              className="rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-40"
            >
              {t("export")}
            </button>
            {exportOpen && (
              <div className="absolute right-0 z-20 mt-1 min-w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => void exportPdf(new URLSearchParams())}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                >
                  {t("exportAll")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void exportPdf(new URLSearchParams({ allControls: "1" }))
                  }
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                >
                  {t("exportAllControls")}
                </button>
              </div>
            )}
          </div>
      </div>

      <div className="mb-3 text-sm text-slate-500">
        {t("courseCount", { count: sorted.length })}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {canEdit && (
                <th className="w-12 px-4 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={t("selectAll")}
                    checked={selection.allSelected}
                    ref={(element) => {
                      if (element) {
                        element.indeterminate = selection.someSelected;
                      }
                    }}
                    onChange={selection.toggleAll}
                  />
                </th>
              )}
              <SortHeader
                label={t("course")}
                active={sort.key === "name"}
                direction={sort.dir}
                onClick={() => toggle("name")}
              />
              <th className="hidden px-4 py-2.5 text-left font-medium text-slate-500 md:table-cell">
                {t("classes")}
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-slate-500">
                {t("template")}
              </th>
              <SortHeader
                label={t("mapsColumn")}
                active={sort.key === "maps"}
                direction={sort.dir}
                onClick={() => toggle("maps")}
                align="right"
              />
              <th className="px-4 py-2.5 text-left font-medium text-slate-500">
                {t("status")}
              </th>
              <th className="px-4 py-2.5 text-right font-medium text-slate-500">
                {t("actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((course) => {
              const courseMaps = mapsByCourse.get(course.id) ?? [];
              const issueCount = courseMaps.reduce(
                (count, map) => count + map.validation.issues.length,
                0,
              );
              const templateSeq = courseMaps[0]?.templateId ?? "";
              return (
                <Fragment key={course.id}>
                  <tr
                    data-testid={`course-map-row-${course.id}`}
                    onClick={() =>
                      setExpandedId(
                        expandedId === course.id ? undefined : course.id,
                      )
                    }
                    className={
                      expandedId === course.id
                        ? "cursor-pointer bg-blue-50"
                        : "cursor-pointer hover:bg-slate-50"
                    }
                  >
                    {canEdit && (
                      <td
                        className="px-4 py-3"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          data-testid={`select-map-course-${course.id}`}
                          checked={selection.isSelected(course.id)}
                          onChange={() => selection.toggle(course.id)}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {course.name}
                    </td>
                    <td className="hidden px-4 py-3 text-slate-600 md:table-cell">
                      {course.classes?.map((item) => item.name).join(", ") || "—"}
                    </td>
                    <td
                      className="px-4 py-3"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {canEdit ? (
                        <select
                          data-testid={`course-template-${course.id}`}
                          aria-label={t("selectTemplateForCourse", {
                            course: course.name,
                          })}
                          value={templateSeq}
                          onChange={(event) => {
                            const templateId = Number(event.target.value);
                            if (!templateId) return;
                            void applyTemplate.mutateAsync({
                              templateId,
                              courseIds: [course.id],
                            });
                          }}
                          className="max-w-48 rounded-lg border border-slate-200 px-2 py-1.5"
                        >
                          <option value="">{t("selectTemplate")}</option>
                          {templates.map((template) => (
                            <option key={template.id} value={template.seq}>
                              {template.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        courseMaps[0]?.template?.name ?? "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {courseMaps.length}
                    </td>
                    <td className="px-4 py-3">
                      {courseMaps.length === 0 ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                          {t("noMap")}
                        </span>
                      ) : issueCount === 0 ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                          {t("valid")}
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          {t("issuesCount", { count: issueCount })}
                        </span>
                      )}
                    </td>
                    <td
                      className="px-4 py-3"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="flex justify-end gap-0.5">
                        {courseMaps[0]?.resolved && canEdit && (
                          <button
                            type="button"
                            data-testid={`edit-course-map-${courseMaps[0].seq}`}
                            onClick={() => setEditingMapSeq(courseMaps[0].seq)}
                            title={t("editLayout")}
                            className="flex items-center rounded p-1.5 text-slate-400 transition-colors hover:bg-blue-50 hover:text-blue-700"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15H9v-2.8l8.6-8.6z" />
                            </svg>
                          </button>
                        )}
                        {courseMaps.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              void exportPdf(
                                new URLSearchParams({
                                  courses: String(course.id),
                                }),
                              )
                            }
                            title={t("exportCourse")}
                            className="flex items-center rounded p-1.5 text-slate-400 transition-colors hover:bg-blue-50 hover:text-blue-700"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === course.id && (
                    <tr>
                      <td colSpan={canEdit ? 7 : 6} className="bg-blue-50/60 p-5">
                        <div
                          data-testid={`course-map-group-${course.id}`}
                          className="space-y-2"
                        >
                          {courseMaps.map((map) => (
                            <div
                              key={map.id}
                              data-testid={`course-map-${map.seq}`}
                              className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-100 bg-white px-4 py-3"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="font-medium text-slate-900">
                                  {map.name}
                                </p>
                                <p className="text-xs text-slate-500">
                                  {map.template?.name ?? t("templateMissing")}
                                </p>
                                {!map.validation.valid && (
                                  <ul className="mt-1 text-xs text-amber-700">
                                    {map.validation.issues.slice(0, 3).map(
                                      (issue, index) => (
                                        <li key={`${issue.code}-${index}`}>
                                          {formatMapIssue(t, issue, map.objects)}
                                        </li>
                                      ),
                                    )}
                                  </ul>
                                )}
                              </div>
                              {canEdit && map.resolved && (
                                <button
                                  type="button"
                                  data-testid={`edit-course-map-${map.seq}`}
                                  onClick={() => setEditingMapSeq(map.seq)}
                                  title={t("editLayout")}
                                  className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-700"
                                >
                                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15H9v-2.8l8.6-8.6z" />
                                  </svg>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  void exportPdf(
                                    new URLSearchParams({
                                      maps: String(map.seq),
                                    }),
                                  )
                                }
                                title={t("exportSelected")}
                                className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-700"
                              >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                              </button>
                              {canEdit && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const name = window.prompt(
                                        t("renameMap"),
                                        map.name,
                                      );
                                      if (name?.trim()) {
                                        void updateMap.mutateAsync({
                                          id: map.seq,
                                          name: name.trim(),
                                        });
                                      }
                                    }}
                                    title={t("renameMap")}
                                    className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-700"
                                  >
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.9 3.1a2.1 2.1 0 013 3L8.5 17.5 4 18.8l1.3-4.5L16.9 3.1z" />
                                    </svg>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          t("deleteMapConfirm", {
                                            name: map.name,
                                          }),
                                        )
                                      ) {
                                        void deleteMap.mutateAsync({
                                          id: map.seq,
                                        });
                                      }
                                    }}
                                    title={t("deleteMap")}
                                    className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                  >
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.9 12.1A2 2 0 0116.1 21H7.9a2 2 0 01-2-1.9L5 7m5 4v6m4-6v6m1-10V4H9v3M4 7h16" />
                                    </svg>
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                          {canEdit &&
                            (addingForCourse === course.id ? (
                              <div
                                data-testid="add-course-map-form"
                                className="flex flex-wrap items-end gap-3 rounded-lg border border-blue-200 bg-white p-3"
                              >
                                <label className="text-xs font-medium text-slate-600">
                                  {t("template")}
                                  <select
                                    value={addTemplateSeq ?? ""}
                                    onChange={(event) =>
                                      setAddTemplateSeq(
                                        event.target.value
                                          ? Number(event.target.value)
                                          : null,
                                      )
                                    }
                                    className="ml-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                                  >
                                    <option value="">
                                      {t("selectTemplate")}
                                    </option>
                                    {templates.map((template) => (
                                      <option
                                        key={template.id}
                                        value={template.seq}
                                      >
                                        {template.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <button
                                  type="button"
                                  data-testid="add-course-map-submit"
                                  disabled={!addTemplateSeq}
                                  onClick={() => {
                                    if (!addTemplateSeq) return;
                                    void createMap
                                      .mutateAsync({
                                        kind: "course",
                                        courseId: course.id,
                                        templateId: addTemplateSeq,
                                        overrides: {},
                                        objects: [],
                                      })
                                      .then(() => {
                                        setAddingForCourse(null);
                                        setAddTemplateSeq(null);
                                      });
                                  }}
                                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                                >
                                  {t("addMap")}
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                title={t("addMap")}
                                onClick={() => {
                                  setAddingForCourse(course.id);
                                  setAddTemplateSeq(
                                    courseMaps[0]?.templateId ??
                                      templates[0]?.seq ??
                                      null,
                                  );
                                }}
                                className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-700"
                              >
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                              </button>
                            ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
        {courses.length === 0 && !coursesQuery.isLoading && (
          <p className="p-8 text-center text-sm text-slate-400">
            {t("noMaps")}
          </p>
        )}
      </div>

      {allControls.map((map) => (
        <div
          key={map.id}
          data-testid="course-map-group-all"
          className="mt-5 flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <div className="flex-1">
            <p className="font-semibold text-slate-900">{t("allControls")}</p>
            <p className="text-xs text-slate-500">
              {map.template?.name ?? t("templateMissing")}
            </p>
          </div>
          {canEdit && map.resolved && (
            <button
              type="button"
              onClick={() => setEditingMapSeq(map.seq)}
              className="rounded-lg border border-blue-200 px-3 py-1.5 text-sm text-blue-700"
            >
              {t("editLayout")}
            </button>
          )}
        </div>
      ))}

      <BulkActionBar
        count={selection.count}
        onDeselectAll={selection.clearSelection}
      >
        <select
          value={bulkTemplate ?? ""}
          onChange={(event) =>
            setBulkTemplate(
              event.target.value ? Number(event.target.value) : null,
            )
          }
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
        >
          <option value="">{t("selectTemplate")}</option>
          {templates.map((template) => (
            <option key={template.id} value={template.seq}>
              {template.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="apply-map-template"
          disabled={!bulkTemplate}
          onClick={() => {
            if (!bulkTemplate) return;
            void applyTemplate
              .mutateAsync({
                templateId: bulkTemplate,
                courseIds: [...selection.selected],
              })
              .then(() => selection.clearSelection());
          }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {t("applySelected")}
        </button>
      </BulkActionBar>

      {editingMap?.resolved && (
        <MapLayoutEditor
          key={editingMap.seq}
          mode="map"
          nameId={nameId}
          mapName={editingMap.name}
          document={editingMap.resolved.document}
          window={editingMap.resolved.window}
          controls={editingMap.controls}
          legs={editingMap.legs}
          descriptionRows={editingMap.descriptionRows}
          descriptionHeader={editingMap.descriptionHeader ?? null}
          descriptionTitle={
            editingMap.kind === "all_controls"
              ? editingMap.name
              : editingMap.course?.name ?? editingMap.name
          }
          allControls={editingMap.kind === "all_controls"}
          mapObjects={editingMap.objects}
          templateObjects={editingMap.resolved.document.objects.slice(
            0,
            Math.max(
              0,
              editingMap.resolved.document.objects.length -
                editingMap.objects.length,
            ),
          )}
          textValues={{
            event: nameId,
            course: editingMap.course?.name ?? editingMap.name,
            map: editingMap.name,
            variant: "",
            classes:
              editingMap.course?.classes?.map((item) => item.name).join(", ") ??
              "",
            length: editingMap.course?.lengthM
              ? `${(editingMap.course.lengthM / 1_000).toFixed(1)} km`
              : "",
            climb: editingMap.course?.climbM
              ? `${editingMap.course.climbM} m`
              : "",
            controls: String(
              editingMap.controls.filter(
                (control) => control.type === "control",
              ).length,
            ),
            date: "",
          }}
          templateEditHref={`/${encodeURIComponent(nameId)}/map-templates?template=${editingMap.templateId ?? ""}`}
          onSave={saveLayout}
          onClose={() => setEditingMapSeq(null)}
        />
      )}
    </div>
  );
}

function formatMapIssue(
  t: (key: "templateMissing" | "mapScaleMissing" | "controlOutsideFrame" | "descriptionOutsidePage" | "objectOutsidePageNamed" | "objectKindText" | "objectKindLine" | "objectKindPath" | "objectKindRectangle" | "objectKindWhiteout" | "objectKindWhiteoutInverted" | "objectKindOutOfBounds" | "objectKindPolygon" | "objectKindImage", options?: Record<string, string>) => string,
  issue: { code: string; controlId?: string; objectId?: string; message?: string },
  objects: CourseMapView["objects"],
): string {
  switch (issue.code) {
    case "template_missing":
      return t("templateMissing");
    case "map_scale_missing":
      return t("mapScaleMissing");
    case "control_outside_frame": {
      const fromMessage = /Control\s+(\S+)/i.exec(issue.message ?? "")?.[1];
      return t("controlOutsideFrame", {
        code: fromMessage ?? issue.controlId ?? "?",
      });
    }
    case "description_outside_page":
      return t("descriptionOutsidePage");
    case "object_outside_page": {
      const object = objects.find((entry) => entry.id === issue.objectId);
      let label = t("objectKindRectangle");
      if (object?.kind === "text") {
        label = object.text.trim() || t("objectKindText");
      } else if (object?.kind === "line") {
        label = t("objectKindLine");
      } else if (object?.kind === "image") {
        label = t("objectKindImage");
      } else if (object?.kind === "path") {
        label =
          object.fillMode === "whiteout"
            ? t("objectKindWhiteout")
            : object.fillMode === "whiteoutInverted"
              ? t("objectKindWhiteoutInverted")
              : object.fillMode === "outOfBounds"
                ? t("objectKindOutOfBounds")
                : object.closed
                  ? t("objectKindPolygon")
                  : t("objectKindPath");
      } else if (object?.kind === "rectangle") {
        label =
          object.fillMode === "whiteout"
            ? t("objectKindWhiteout")
            : object.fillMode === "whiteoutInverted"
              ? t("objectKindWhiteoutInverted")
              : object.fillMode === "outOfBounds"
                ? t("objectKindOutOfBounds")
                : t("objectKindRectangle");
      }
      return t("objectOutsidePageNamed", { name: label });
    }
    default:
      return issue.message ?? issue.code;
  }
}
