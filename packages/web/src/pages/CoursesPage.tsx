import { Fragment, useState, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { type CourseSummary } from "@oxygen/shared";
import { useNumericSearchParam } from "../hooks/useSearchParam";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { useTableSelection } from "../hooks/useTableSelection";
import { BulkActionBar } from "../components/BulkActionBar";
import { CourseImportDialog } from "../components/CourseImportDialog";
import { MapSlot } from "../components/MapSlot";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import { createCourseAnchors } from "../lib/structured-search/anchors/course-anchors";
import { downloadSameOriginFile } from "../lib/download-api";
import {
  courselessClassNames,
  matchCourselessClass,
} from "../lib/course-editor";

export function CoursesPage() {
  const { t } = useTranslation("courses");
  const { nameId } = useParams<{ nameId: string }>();
  const [expandedId, setExpandedId] = useNumericSearchParam("course");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);

  const utils = trpc.useUtils();

  const anchors = useMemo(() => createCourseAnchors((key) => t(key as never)), [t]);
  const { tokens, setTokens, filterItems } = useStructuredSearch<CourseSummary>(
    anchors,
    ["name"],
  );

  const courses = trpc.course.list.useQuery();

  const deleteMutation = trpc.course.delete.useMutation({
    onSuccess: () => {
      utils.course.list.invalidate();
      utils.course.detail.invalidate();
    },
  });

  const [bulkValue, setBulkValue] = useState<string>("");

  const handleDelete = (id: number, name: string) => {
    if (window.confirm(t("removeConfirm", { name }))) {
      deleteMutation.mutate({ id });
    }
  };

  const handleToggleExpand = (id: number) => {
    setExpandedId(expandedId === id ? undefined : id);
  };

  type Course = NonNullable<typeof courses.data>[number];
  const comparators = useMemo(() => ({
    name: (a: Course, b: Course) => a.name.localeCompare(b.name),
    controls: (a: Course, b: Course) => a.controlCount - b.controlCount,
    length: (a: Course, b: Course) => a.length - b.length,
    maps: (a: Course, b: Course) => a.numberOfMaps - b.numberOfMaps,
  }), []);

  const filtered = useMemo(() => filterItems(courses.data ?? []), [courses.data, filterItems]);
  const { sorted: items, sort, toggle } = useSort(filtered, { key: "name", dir: "asc" }, comparators);

  const selection = useTableSelection(items);

  const bulkUpdateMutation = trpc.course.bulkUpdate.useMutation({
    onSuccess: () => {
      utils.course.list.invalidate();
      utils.course.detail.invalidate();
      selection.clearSelection();
      setBulkValue("");
    },
  });

  // Names of selected courses — drive the map filter when selection is non-empty
  const selectedCourseNames = useMemo(
    () => items.filter((c) => selection.isSelected(c.id)).map((c) => c.name),
    [items, selection],
  );

  const handleApplyBulk = () => {
    if (bulkValue === "" || selection.count === 0) return;
    if (!window.confirm(t("bulkConfirm", {
      field: t("maps").toLowerCase(),
      value: bulkValue,
      count: selection.count,
    }))) return;
    const value = parseInt(bulkValue, 10);
    if (Number.isNaN(value) || value < 0) return;
    bulkUpdateMutation.mutate({
      ids: Array.from(selection.selected),
      numberOfMaps: value,
    });
  };

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={anchors}
          placeholder={t("searchPlaceholder")}
        />
        <button
          onClick={() => setShowImportDialog(true)}
          className="px-4 py-2 border border-blue-200 text-blue-700 text-sm font-medium rounded-lg hover:bg-blue-50 transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          {t("importCourses")}
        </button>
        {(courses.data?.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={() =>
              void downloadSameOriginFile(
                `/api/export/course-data?name=${encodeURIComponent(nameId ?? "")}`,
              )
            }
            data-testid="course-export-link"
            title={t("exportCoursesTitle")}
            className="px-4 py-2 border border-blue-200 text-blue-700 text-sm font-medium rounded-lg hover:bg-blue-50 transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {t("exportCourses")}
          </button>
        )}
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t("newCourse")}
        </button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-500">
          {t("courseCount", { count: items.length })}
        </span>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <CreateCourseForm
          onClose={() => setShowCreateForm(false)}
          onCreated={() => {
            setShowCreateForm(false);
            utils.course.list.invalidate();
          }}
        />
      )}

      {showImportDialog && (
        <CourseImportDialog
          onClose={() => setShowImportDialog(false)}
          onSuccess={() => {
            // Course/control lists drive the table.
            utils.course.list.invalidate();
            utils.control.list.invalidate();
            // Map overlays are cached with `staleTime: Infinity` (the
            // tile URLs key off `mapMetadata.uploadedAt`), so a re-
            // import otherwise leaves the viewer rendering stale
            // controls / leg lines until a full page refresh.
            utils.course.controlCoordinates.invalidate();
            utils.course.courseGeometries.invalidate();
            utils.course.mapMetadata.invalidate();
            utils.course.mapFileInfo.invalidate();
            utils.course.geometry.invalidate();
          }}
        />
      )}

      {/* Courses table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {courses.isLoading && (
          <div className="p-8 text-center">
            <div className="inline-block w-6 h-6 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        )}
        {items.length === 0 && !courses.isLoading && (
          <div className="p-8 text-center text-slate-400 text-sm">
            {t("noCourses")}
          </div>
        )}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-3 py-2.5 w-10">
                    <input
                      type="checkbox"
                      checked={selection.allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = selection.someSelected && !selection.allSelected;
                      }}
                      onChange={selection.toggleAll}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                  </th>
                  <SortHeader label={t("name")} active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
                  <SortHeader label={t("controls")} active={sort.key === "controls"} direction={sort.dir} onClick={() => toggle("controls")} className="w-24" />
                  <SortHeader label={t("length")} active={sort.key === "length"} direction={sort.dir} onClick={() => toggle("length")} className="w-24" />
                  <SortHeader label={t("maps")} active={sort.key === "maps"} direction={sort.dir} onClick={() => toggle("maps")} className="hidden md:table-cell w-20" />
                  <th className="px-4 py-2.5 text-left font-medium text-slate-500 hidden lg:table-cell w-32">{t("options")}</th>
                  <th className="px-4 py-2.5 text-right font-medium text-slate-500 w-24">{t("actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((c) => (
                  <Fragment key={c.id}>
                    <tr
                      className={`transition-colors cursor-pointer ${expandedId === c.id ? "bg-blue-50" : "hover:bg-slate-50"
                        }`}
                      onClick={() => handleToggleExpand(c.id)}
                    >
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selection.isSelected(c.id)}
                          onChange={() => selection.toggle(c.id)}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-2.5 font-medium text-slate-700">
                        {c.name}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-slate-600">
                        {c.controlCount}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-slate-600">
                        {c.length > 0
                          ? `${(c.length / 1000).toFixed(1)} km`
                          : <span className="text-slate-300">—</span>
                        }
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-slate-500 hidden md:table-cell">
                        {c.numberOfMaps}
                      </td>
                      <td className="px-4 py-2.5 hidden lg:table-cell">
                        <div className="flex gap-1.5">
                          {c.firstAsStart && (
                            <span
                              data-testid="course-legacy-first-start"
                              className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700"
                            >
                              {t("legacyFirstAsStart")}
                            </span>
                          )}
                          {c.lastAsFinish && (
                            <span
                              data-testid="course-legacy-last-finish"
                              className="px-1.5 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700"
                            >
                              {t("legacyLastAsFinish")}
                            </span>
                          )}
                          {!c.firstAsStart && !c.lastAsFinish && (
                            <span className="text-slate-300">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5">
                        <Link
                          to={`/${nameId}/course-editor?course=${c.id}`}
                          data-testid="course-edit-link"
                          className="p-1.5 text-slate-400 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors flex items-center"
                          title={t("openInCourseEditor")}
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </Link>
                        <button
                          onClick={() => handleDelete(c.id, c.name)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer flex items-center"
                          title={t("removeCourse")}
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                        </div>
                      </td>
                    </tr>
                    {expandedId === c.id && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <CourseInlineDetail courseId={c.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Map — selection drives the filter when non-empty, otherwise the
          expanded row is highlighted as before. */}
      <MapSlot
        className="mt-6"
        fitToControls
        highlightCourseName={
          selectedCourseNames.length === 0 && expandedId
            ? items.find((c) => c.id === expandedId)?.name
            : undefined
        }
        highlightCourseNames={selectedCourseNames.length > 0 ? selectedCourseNames : undefined}
      />

      {/* Bulk action bar — floating at bottom, same as Classes/Runners */}
      <BulkActionBar count={selection.count} onDeselectAll={selection.clearSelection}>
        <select
          value="numberOfMaps"
          disabled
          className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          data-testid="bulk-field-select"
        >
          <option value="numberOfMaps">{t("maps")}</option>
        </select>
        <input
          type="number"
          min={0}
          value={bulkValue}
          onChange={(e) => setBulkValue(e.target.value)}
          placeholder="0"
          className="w-24 px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
          data-testid="bulk-value-input"
        />
        <button
          onClick={handleApplyBulk}
          disabled={bulkValue === "" || bulkUpdateMutation.isPending}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
        >
          {bulkUpdateMutation.isPending ? t("applying") : t("apply")}
        </button>
      </BulkActionBar>
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function formatLength(meters: number): string {
  if (meters <= 0) return "";
  return `${(meters / 1000).toFixed(1)} km`;
}

// ─── Inline detail (expanded view) ──────────────────────────

function CourseInlineDetail({ courseId }: { courseId: number }) {
  const { t } = useTranslation("courses");
  const utils = trpc.useUtils();
  const detail = trpc.course.detail.useQuery({ id: courseId });
  const updateMutation = trpc.course.update.useMutation({
    onSuccess: () => {
      utils.course.list.invalidate();
      utils.course.detail.invalidate();
    },
  });

  const [editName, setEditName] = useState<string | null>(null);
  const [editControls, setEditControls] = useState<string | null>(null);
  const [controlsError, setControlsError] = useState<string | null>(null);
  const [editLength, setEditLength] = useState<string | null>(null);
  const [editMaps, setEditMaps] = useState<string | null>(null);

  if (detail.isLoading) {
    return (
      <div className="bg-blue-50/60 p-6 text-center">
        <div className="inline-block w-5 h-5 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!detail.data) {
    return (
      <div className="bg-blue-50/60 p-6 text-center text-slate-400 text-sm">
        {t("courseNotFound")}
      </div>
    );
  }

  const d = detail.data;

  const handleSave = (field: string, value: string | number | boolean) => {
    updateMutation.mutate({ id: courseId, [field]: value });
  };

  /**
   * Live-codes view of the control sequence: what the user sees and edits.
   * `oCourse.Controls` itself stores oControl.Id values (MeOS-compatible);
   * the server resolves Ids to live codes for display and translates the
   * user's edits back to Ids on save.
   */
  const controlsCodeString = d.controlCodes.map((c) => c.code).join(";");

  const handleSaveControlCodes = (value: string) => {
    setControlsError(null);
    const codes = value
      .split(/[;,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    updateMutation.mutate(
      {
        id: courseId,
        controlIds: codes.map((c) => parseInt(c, 10)).filter((n) => !isNaN(n)),
      },
      {
        onError: (err) => setControlsError(err.message),
      },
    );
  };

  return (
    <div className="bg-blue-50/60 border-t border-blue-100 p-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Editable fields */}
        <div className="lg:col-span-2 space-y-4">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {t("courseSettings")}
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("name")}</label>
              <input
                type="text"
                value={editName ?? d.name}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => {
                  if (editName !== null && editName !== d.name) {
                    handleSave("name", editName);
                  }
                  setEditName(null);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  {t("lengthM")}
                </label>
                <input
                  type="number"
                  value={editLength ?? String(d.length)}
                  onChange={(e) => setEditLength(e.target.value)}
                  onBlur={() => {
                    if (editLength !== null) {
                      const val = parseInt(editLength, 10);
                      if (!isNaN(val) && val !== d.length) {
                        handleSave("length", val);
                      }
                    }
                    setEditLength(null);
                  }}
                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                  min={0}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  {t("maps")}
                </label>
                <input
                  type="number"
                  value={editMaps ?? String(d.numberOfMaps)}
                  onChange={(e) => setEditMaps(e.target.value)}
                  onBlur={() => {
                    if (editMaps !== null) {
                      const val = parseInt(editMaps, 10);
                      if (!isNaN(val) && val !== d.numberOfMaps) {
                        handleSave("numberOfMaps", val);
                      }
                    }
                    setEditMaps(null);
                  }}
                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                  min={0}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              {t("controls")}
            </label>
            <input
              type="text"
              value={editControls ?? controlsCodeString}
              onChange={(e) => {
                setEditControls(e.target.value);
                if (controlsError) setControlsError(null);
              }}
              onBlur={() => {
                if (editControls !== null && editControls !== controlsCodeString) {
                  handleSaveControlCodes(editControls);
                }
                setEditControls(null);
              }}
              className={`w-full px-3 py-1.5 border rounded-lg text-sm font-mono bg-white focus:outline-none focus:ring-2 ${
                controlsError
                  ? "border-rose-300 focus:ring-rose-500"
                  : "border-slate-200 focus:ring-blue-500"
              }`}
              placeholder={t("controlsPlaceholder")}
            />
            {controlsError ? (
              <p className="text-xs text-rose-600 mt-1">{controlsError}</p>
            ) : (
              <p className="text-xs text-slate-400 mt-1">
                {t("controlsHelp")}
                {d.controlCount > 0 && (
                  <span className="ml-1 font-medium text-slate-500">
                    {t("controlCount", { count: d.controlCount })}
                    {d.length > 0 && ` — ${formatLength(d.length)}`}
                  </span>
                )}
              </p>
            )}
          </div>

          {/* Visual control sequence */}
          {d.controlCodes.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-2">
                {t("controlSequence")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {d.controlCodes.map((c, i) => (
                  <div key={`${c.id}-${i}`} className="flex items-center gap-1">
                    {i > 0 && (
                      <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    )}
                    <span className="inline-flex items-center justify-center min-w-[2rem] h-7 px-2 rounded-md bg-white border border-slate-200 text-xs font-mono font-medium text-slate-700 tabular-nums">
                      {c.code}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Class usage */}
        <div>
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            {t("usedByClasses")}
          </h4>
          {d.classes.length === 0 ? (
            <p className="text-sm text-slate-400">{t("notAssigned")}</p>
          ) : (
            <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
              {d.classes.map((cls) => (
                <div key={cls.classId} className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">
                    {cls.className}
                  </span>
                  <span className="text-xs text-slate-500">
                    {t("runnerCount", { count: cls.runnerCount })}
                  </span>
                </div>
              ))}
              <div className="px-4 py-2 bg-slate-50 text-xs text-slate-500">
                {t("totalRunnersAcrossClasses", { runners: d.classes.reduce((sum, c) => sum + c.runnerCount, 0), classes: d.classes.length })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Create course form ──────────────────────────────────────

function CreateCourseForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation("courses");
  const [name, setName] = useState("");
  const [controls, setControls] = useState("");
  const [length, setLength] = useState("");
  const [numberOfMaps, setNumberOfMaps] = useState("1");
  const utils = trpc.useUtils();
  const classes = trpc.class.list.useQuery();
  const courses = trpc.course.list.useQuery();
  const suggestions = useMemo(
    () =>
      courselessClassNames(
        classes.data ?? [],
        (courses.data ?? []).map((course) => course.name),
      ),
    [classes.data, courses.data],
  );

  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = trpc.course.create.useMutation({
    onSuccess: () => {
      void utils.class.list.invalidate();
      onCreated();
    },
    onError: (err) => setCreateError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreateError(null);
    const codes = controls
      .split(/[;,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    createMutation.mutate({
      name: name.trim(),
      controlIds: codes.map((c) => parseInt(c, 10)).filter((n) => !isNaN(n)),
      length: parseInt(length, 10) || 0,
      numberOfMaps: parseInt(numberOfMaps, 10) || 1,
      linkClassId:
        matchCourselessClass(name.trim(), classes.data ?? []) ?? undefined,
    });
  };

  return (
    <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-900">{t("newCourse")}</h3>
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-slate-600 rounded cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("name")}</label>
            <input
              type="text"
              list="course-create-suggestions"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
              required
            />
            <datalist id="course-create-suggestions">
              {suggestions.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          </div>
          <div className="sm:w-32">
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("lengthM")}</label>
            <input
              type="number"
              value={length}
              onChange={(e) => setLength(e.target.value)}
              placeholder={t("lengthPlaceholder")}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
              min={0}
            />
          </div>
          <div className="sm:w-20">
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("maps")}</label>
            <input
              type="number"
              value={numberOfMaps}
              onChange={(e) => setNumberOfMaps(e.target.value)}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
              min={0}
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("controls")}</label>
          <input
            type="text"
            value={controls}
            onChange={(e) => {
              setControls(e.target.value);
              if (createError) setCreateError(null);
            }}
            placeholder={t("controlsCreatePlaceholder")}
            className={`w-full px-3 py-1.5 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 ${
              createError
                ? "border-rose-300 focus:ring-rose-500"
                : "border-slate-200 focus:ring-blue-500"
            }`}
          />
          {createError && (
            <p className="text-xs text-rose-600 mt-1">{createError}</p>
          )}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={createMutation.isPending || !name.trim()}
            className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {createMutation.isPending ? t("creating") : t("create")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-slate-500 text-sm hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          >
            {t("cancel")}
          </button>
        </div>
      </form>
      {createMutation.isError && (
        <div className="mt-3 text-sm text-red-600">
          {createMutation.error.message}
        </div>
      )}
    </div>
  );
}
