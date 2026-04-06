import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { formatMeosTime, parseMeosTime, type ClassSummary } from "@oxygen/shared";
import { useSearchParam, useNumericSearchParam } from "../hooks/useSearchParam";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { useTableSelection } from "../hooks/useTableSelection";
import { BulkActionBar } from "../components/BulkActionBar";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { MapPanel } from "../components/MapPanel";

export function ClassesPage() {
  const { t } = useTranslation("classes");
  const [search, setSearch] = useSearchParam("search");
  const [expandedId, setExpandedId] = useNumericSearchParam("classId");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const utils = trpc.useUtils();

  const classes = trpc.class.list.useQuery({
    search: search || undefined,
  });

  const selection = useTableSelection(classes.data ?? []);

  const [bulkField, setBulkField] = useState<"fee" | "freeStart" | "noTiming" | "allowQuickEntry" | "maxTime">("fee");
  const [bulkValue, setBulkValue] = useState<string>("");

  const bulkUpdateMutation = trpc.class.bulkUpdate.useMutation({
    onSuccess: () => {
      utils.class.list.invalidate();
      utils.class.detail.invalidate();
      selection.clearSelection();
    },
  });

  const handleApplyBulk = () => {
    if (bulkValue === "") return;
    const fieldLabel = bulkField === "fee" ? t("fee").toLowerCase() : bulkField === "maxTime" ? t("maxTime").toLowerCase() : bulkField === "freeStart" ? t("freeStart").toLowerCase() : bulkField === "noTiming" ? t("noTiming").toLowerCase() : t("allowQuickEntry").toLowerCase();
    const valueLabel = bulkField === "fee" ? `${bulkValue} kr` : bulkField === "maxTime" ? bulkValue : bulkValue === "1" ? t("yes") : t("no");
    if (!window.confirm(t("bulkConfirm", { field: fieldLabel, value: valueLabel, count: selection.count }))) return;

    const data: { classFee?: number; freeStart?: boolean; noTiming?: boolean; allowQuickEntry?: boolean; maxTime?: number } = {};
    if (bulkField === "fee") data.classFee = parseInt(bulkValue, 10) || 0;
    else if (bulkField === "maxTime") data.maxTime = bulkValue.trim() ? parseMeosTime(bulkValue) : 0;
    else if (bulkField === "freeStart") data.freeStart = bulkValue === "1";
    else if (bulkField === "noTiming") data.noTiming = bulkValue === "1";
    else if (bulkField === "allowQuickEntry") data.allowQuickEntry = bulkValue === "1";

    bulkUpdateMutation.mutate({
      ids: Array.from(selection.selected),
      data,
    });
  };

  const deleteMutation = trpc.class.delete.useMutation({
    onSuccess: () => {
      utils.class.list.invalidate();
      utils.class.detail.invalidate();
    },
  });

  const reorderMutation = trpc.class.reorder.useMutation({
    onSuccess: () => {
      utils.class.list.invalidate();
    },
  });

  const handleDelete = (id: number, name: string) => {
    if (window.confirm(t("removeConfirm", { name }))) {
      deleteMutation.mutate({ id });
    }
  };

  const handleToggleExpand = (id: number) => {
    setExpandedId(expandedId === id ? undefined : id);
  };

  const rawItems = classes.data ?? [];
  const isFiltered = !!search;

  type Cls = (typeof rawItems)[number];
  const comparators = useMemo(() => ({
    name: (a: Cls, b: Cls) => a.name.localeCompare(b.name),
    course: (a: Cls, b: Cls) => (a.courseNames[0] ?? "").localeCompare(b.courseNames[0] ?? ""),
    runners: (a: Cls, b: Cls) => a.runnerCount - b.runnerCount,
    fee: (a: Cls, b: Cls) => a.classFee - b.classFee,
    sex: (a: Cls, b: Cls) => a.sex.localeCompare(b.sex),
    type: (a: Cls, b: Cls) => (a.classType ?? "").localeCompare(b.classType ?? ""),
  }), []);

  const { sorted: sortedItems, sort, toggle } = useSort(rawItems, { key: "name", dir: "asc" }, comparators);

  // Only use column sorting when DnD is disabled (i.e. when filtered)
  const items = isFiltered ? sortedItems : rawItems;

  // DnD sensors — require 8px movement to start drag (prevents accidental drags)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const sortableIds = useMemo(() => items.map((c) => c.id), [items]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex((c) => c.id === active.id);
    const newIndex = items.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(items, oldIndex, newIndex);

    // Assign new sort indices (10, 20, 30, ...) to keep gaps
    const updates = reordered.map((cls, i) => ({
      id: cls.id,
      sortIndex: (i + 1) * 10,
    }));

    reorderMutation.mutate({ items: updates });
  };

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          />
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t("newClass")}
        </button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-500">
          {t("classCount", { count: items.length })}
          {!isFiltered && items.length > 1 && (
            <span className="text-slate-400 ml-2">· {t("dragToReorder")}</span>
          )}
        </span>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <CreateClassForm
          onClose={() => setShowCreateForm(false)}
          onCreated={() => {
            setShowCreateForm(false);
            utils.class.list.invalidate();
          }}
        />
      )}

      {/* Classes table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {classes.isLoading && (
          <div className="p-8 text-center">
            <div className="inline-block w-6 h-6 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        )}
        {items.length === 0 && !classes.isLoading && (
          <div className="p-8 text-center text-slate-400 text-sm">
            {t("noClasses")}
          </div>
        )}
        {items.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis]}
          >
            <SortableContext
              items={sortableIds}
              strategy={verticalListSortingStrategy}
              disabled={isFiltered || selection.someSelected}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="w-10 px-1 py-2.5">
                        <input
                          type="checkbox"
                          checked={selection.allSelected}
                          ref={(el) => { if (el) el.indeterminate = selection.someSelected && !selection.allSelected; }}
                          onChange={selection.toggleAll}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        />
                      </th>
                      {!isFiltered && !selection.someSelected && (
                        <th className="w-10 px-1 py-2.5" />
                      )}
                      <SortHeader label={t("name")} active={isFiltered ? sort.key === "name" : undefined} direction={sort.dir} onClick={() => toggle("name")} />
                      <SortHeader label={t("course")} active={isFiltered ? sort.key === "course" : undefined} direction={sort.dir} onClick={() => toggle("course")} />
                      <SortHeader label={t("runners")} active={isFiltered ? sort.key === "runners" : undefined} direction={sort.dir} onClick={() => toggle("runners")} className="w-24" />
                      <SortHeader label={t("fee")} active={isFiltered ? sort.key === "fee" : undefined} direction={sort.dir} onClick={() => toggle("fee")} className="hidden sm:table-cell w-20" />
                      <SortHeader label={t("sex")} active={isFiltered ? sort.key === "sex" : undefined} direction={sort.dir} onClick={() => toggle("sex")} className="hidden md:table-cell w-24" />
                      <SortHeader label={t("classType")} active={isFiltered ? sort.key === "type" : undefined} direction={sort.dir} onClick={() => toggle("type")} className="hidden lg:table-cell" />
                      <th className="px-4 py-2.5 text-left font-medium text-slate-500 hidden xl:table-cell w-52">{t("options")}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-slate-500 w-20">{t("actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((cls) => (
                      <SortableClassRow
                        key={cls.id}
                        cls={cls}
                        isExpanded={expandedId === cls.id}
                        isFiltered={isFiltered}
                        isDndDisabled={isFiltered || selection.someSelected}
                        isSelected={selection.isSelected(cls.id)}
                        onToggleSelect={() => selection.toggle(cls.id)}
                        onToggleExpand={() => handleToggleExpand(cls.id)}
                        onDelete={() => handleDelete(cls.id, cls.name)}
                        colSpan={99}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Bulk action bar */}
      <BulkActionBar count={selection.count} onDeselectAll={selection.clearSelection}>
        <select
          value={bulkField}
          onChange={(e) => { setBulkField(e.target.value as typeof bulkField); setBulkValue(""); }}
          className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
        >
          <option value="fee">{t("fee")}</option>
          <option value="maxTime">{t("maxTime")}</option>
          <option value="freeStart">{t("freeStart")}</option>
          <option value="noTiming">{t("noTiming")}</option>
          <option value="allowQuickEntry">{t("allowQuickEntry")}</option>
        </select>
        {bulkField === "fee" ? (
          <input
            type="number"
            min={0}
            value={bulkValue}
            onChange={(e) => setBulkValue(e.target.value)}
            placeholder="0"
            className="w-24 px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
          />
        ) : bulkField === "maxTime" ? (
          <input
            type="text"
            value={bulkValue}
            onChange={(e) => setBulkValue(e.target.value)}
            placeholder="H:MM:SS"
            className="w-28 px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
          />
        ) : (
          <select
            value={bulkValue}
            onChange={(e) => setBulkValue(e.target.value)}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            <option value="">—</option>
            <option value="1">{t("yes")}</option>
            <option value="0">{t("no")}</option>
          </select>
        )}
        <button
          onClick={handleApplyBulk}
          disabled={bulkValue === "" || bulkUpdateMutation.isPending}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
        >
          {bulkUpdateMutation.isPending ? t("applying") : t("apply")}
        </button>
      </BulkActionBar>

      {/* Map */}
      <MapPanel
        className="mt-6"
        fitToControls
        highlightCourseNames={
          expandedId
            ? (items.find((c) => c.id === expandedId)?.courseNames ?? [])
            : undefined
        }
      />
    </>
  );
}

// ─── Sortable row component ─────────────────────────────────

function SortableClassRow({
  cls,
  isExpanded,
  isFiltered,
  isDndDisabled,
  isSelected,
  onToggleSelect,
  onToggleExpand,
  onDelete,
  colSpan,
}: {
  cls: ClassSummary;
  isExpanded: boolean;
  isFiltered: boolean;
  isDndDisabled: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onDelete: () => void;
  colSpan: number;
}) {
  const { t } = useTranslation("classes");
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cls.id, disabled: isDndDisabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 10 : undefined,
    position: isDragging ? ("relative" as const) : undefined,
  };

  return (
    <>
      <tr
        ref={setNodeRef}
        style={style}
        className={`transition-colors cursor-pointer ${
          isSelected ? "bg-blue-50/80" : isExpanded ? "bg-blue-50" : "hover:bg-slate-50"
        } ${isDragging ? "shadow-lg bg-white" : ""}`}
        onClick={onToggleExpand}
      >
        <td className="w-10 px-1 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
        </td>
        {!isFiltered && !isDndDisabled && (
          <td
            className="w-10 px-1 py-2.5 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="p-1 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing touch-none"
              aria-label={t("dragLabel")}
              {...attributes}
              {...listeners}
            >
              <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="5" cy="3" r="1.5" />
                <circle cx="11" cy="3" r="1.5" />
                <circle cx="5" cy="8" r="1.5" />
                <circle cx="11" cy="8" r="1.5" />
                <circle cx="5" cy="13" r="1.5" />
                <circle cx="11" cy="13" r="1.5" />
              </svg>
            </button>
          </td>
        )}
        <td className="px-4 py-2.5 font-medium text-slate-700">
          {cls.name}
        </td>
        <td className="px-4 py-2.5 text-slate-600">
          {cls.courseIds.length > 1 ? (
            <span className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">
                {t("courseForked")}
              </span>
              <span className="text-xs text-slate-400">
                {cls.courseNames.join(", ")}
              </span>
            </span>
          ) : cls.courseNames.length > 0 ? (
            cls.courseNames[0]
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="px-4 py-2.5 tabular-nums text-slate-600">
          {cls.runnerCount}
        </td>
        <td className="px-4 py-2.5 tabular-nums text-right hidden sm:table-cell">
          {cls.classFee > 0 ? (
            <span className="text-slate-600">{cls.classFee} kr</span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-slate-500 hidden md:table-cell">
          {cls.sex === "M" ? t("sexMen") : cls.sex === "F" || cls.sex === "W" ? t("sexWomen") : t("open")}
        </td>
        <td className="px-4 py-2.5 text-slate-500 hidden lg:table-cell text-xs">
          {cls.classType || "—"}
        </td>
        <td className="px-4 py-2.5 hidden xl:table-cell">
          <div className="flex gap-1.5">
            {cls.freeStart && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                {t("freeStart")}
              </span>
            )}
            {cls.noTiming && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                {t("noTiming")}
              </span>
            )}
            {cls.allowQuickEntry && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                {t("allowQuickEntry")}
              </span>
            )}
            {cls.maxTime > 0 && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 tabular-nums">
                {t("maxTime")} {formatMeosTime(cls.maxTime)}
              </span>
            )}
            {!cls.freeStart && !cls.noTiming && !cls.allowQuickEntry && !cls.maxTime && (
              <span className="text-slate-300">—</span>
            )}
          </div>
        </td>
        <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onDelete}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer"
            title={t("removeClass")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={colSpan} className="p-0">
            <ClassInlineDetail classId={cls.id} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

// formatSex is no longer used directly -- replaced by t() calls in components

function formatAge(low: number, high: number): string {
  if (low > 0 && high > 0) return `${low}–${high}`;
  if (low > 0) return `${low}+`;
  if (high > 0) return `≤${high}`;
  return "—";
}

// ─── Multi-select course picker ─────────────────────────────

function CourseMultiSelect({
  selectedIds,
  onChange,
}: {
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}) {
  const { t } = useTranslation("classes");
  const courses = trpc.course.list.useQuery();
  const available = courses.data ?? [];

  const toggleCourse = (id: number) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className="space-y-1.5">
      {available.map((c) => (
        <label
          key={c.id}
          className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 rounded px-2 py-1 -mx-2"
        >
          <input
            type="checkbox"
            checked={selectedIds.includes(c.id)}
            onChange={() => toggleCourse(c.id)}
            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
          <span className="text-sm text-slate-700">{c.name}</span>
          <span className="text-xs text-slate-400 ml-auto">
            {t("controlsCount", { count: c.controlCount })}
            {c.length > 0 && ` · ${(c.length / 1000).toFixed(1)} km`}
          </span>
        </label>
      ))}
      {available.length === 0 && (
        <p className="text-xs text-slate-400">{t("noCoursesAvailable")}</p>
      )}
      {selectedIds.length > 1 && (
        <p className="text-xs text-purple-600 font-medium mt-1">
          {t("forkedDescription")}
        </p>
      )}
    </div>
  );
}

// ─── Inline detail (expanded view) ──────────────────────────

function ClassInlineDetail({ classId }: { classId: number }) {
  const { t } = useTranslation("classes");
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const detail = trpc.class.detail.useQuery({ id: classId });
  const updateMutation = trpc.class.update.useMutation({
    onSuccess: () => {
      utils.class.list.invalidate();
      utils.class.detail.invalidate();
    },
  });

  const [editName, setEditName] = useState<string | null>(null);
  const [editSort, setEditSort] = useState<string | null>(null);
  const [editSex, setEditSex] = useState<string | null>(null);
  const [editLowAge, setEditLowAge] = useState<string | null>(null);
  const [editHighAge, setEditHighAge] = useState<string | null>(null);
  const [editFee, setEditFee] = useState<string | null>(null);
  const [editMaxTime, setEditMaxTime] = useState<string | null>(null);
  const [editCourseIds, setEditCourseIds] = useState<number[] | null>(null);

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
        {t("classNotFound")}
      </div>
    );
  }

  const d = detail.data;

  const handleSave = (field: string, value: unknown) => {
    updateMutation.mutate({ id: classId, [field]: value });
  };

  const handleCourseChange = (ids: number[]) => {
    setEditCourseIds(ids);
    updateMutation.mutate({ id: classId, courseIds: ids });
  };

  return (
    <div className="bg-blue-50/60 border-t border-blue-100 p-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: settings */}
        <div className="lg:col-span-2 space-y-4">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {t("classSettings")}
          </h4>

          {/* Row 1: Name / Sex / Sort index */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("sex")}</label>
              <select
                value={editSex ?? d.sex}
                onChange={(e) => {
                  setEditSex(e.target.value);
                  handleSave("sex", e.target.value);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="">{t("sexOpen")}</option>
                <option value="M">{t("sexMen")}</option>
                <option value="F">{t("sexWomen")}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("sortIndex")}</label>
              <input
                type="number"
                value={editSort ?? String(d.sortIndex)}
                onChange={(e) => setEditSort(e.target.value)}
                onBlur={() => {
                  if (editSort !== null) {
                    const val = parseInt(editSort, 10);
                    if (!isNaN(val) && val !== d.sortIndex) {
                      handleSave("sortIndex", val);
                    }
                  }
                  setEditSort(null);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
              />
            </div>
          </div>

          {/* Row 2: Min age / Max age / Entry fee */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("minAge")}</label>
              <input
                type="number"
                value={editLowAge ?? String(d.lowAge)}
                onChange={(e) => setEditLowAge(e.target.value)}
                onBlur={() => {
                  if (editLowAge !== null) {
                    const val = parseInt(editLowAge, 10);
                    if (!isNaN(val) && val !== d.lowAge) {
                      handleSave("lowAge", val);
                    }
                  }
                  setEditLowAge(null);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                min={0}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("maxAge")}</label>
              <input
                type="number"
                value={editHighAge ?? String(d.highAge)}
                onChange={(e) => setEditHighAge(e.target.value)}
                onBlur={() => {
                  if (editHighAge !== null) {
                    const val = parseInt(editHighAge, 10);
                    if (!isNaN(val) && val !== d.highAge) {
                      handleSave("highAge", val);
                    }
                  }
                  setEditHighAge(null);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                min={0}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("entryFee")}</label>
              <input
                type="number"
                value={editFee ?? String(d.classFee)}
                onChange={(e) => setEditFee(e.target.value)}
                onBlur={() => {
                  if (editFee !== null) {
                    const val = parseInt(editFee, 10);
                    if (!isNaN(val) && val !== d.classFee) {
                      handleSave("classFee", val);
                    }
                  }
                  setEditFee(null);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                min={0}
                placeholder="0"
              />
            </div>
          </div>

          {/* Row 3: Flags (Free start / No timing / Allow quick entry) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("freeStart")}</label>
              <label className="flex items-center gap-2 cursor-pointer h-[34px]">
                <input
                  type="checkbox"
                  checked={d.freeStart}
                  onChange={(e) => handleSave("freeStart", e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
                <span className="text-sm text-slate-600">{d.freeStart ? t("yes") : t("no")}</span>
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("noTiming")}</label>
              <label className="flex items-center gap-2 cursor-pointer h-[34px]">
                <input
                  type="checkbox"
                  checked={d.noTiming}
                  onChange={(e) => handleSave("noTiming", e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
                <span className="text-sm text-slate-600">{d.noTiming ? t("yes") : t("no")}</span>
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("allowQuickEntry")}</label>
              <label className="flex items-center gap-2 cursor-pointer h-[34px]">
                <input
                  type="checkbox"
                  checked={d.allowQuickEntry}
                  onChange={(e) => handleSave("allowQuickEntry", e.target.checked)}
                  className="rounded border-slate-300 text-green-600 focus:ring-green-500 cursor-pointer"
                />
                <span className="text-sm text-slate-600">{d.allowQuickEntry ? t("yes") : t("no")}</span>
              </label>
            </div>
          </div>

          {/* Max time (standalone — less common) */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("maxTime")}</label>
            <input
              type="text"
              value={editMaxTime ?? (d.maxTime > 0 ? formatMeosTime(d.maxTime) : "")}
              onChange={(e) => setEditMaxTime(e.target.value)}
              onBlur={() => {
                if (editMaxTime !== null) {
                  const ds = editMaxTime.trim() ? parseMeosTime(editMaxTime) : 0;
                  if (ds !== d.maxTime) {
                    handleSave("maxTime", ds);
                  }
                }
                setEditMaxTime(null);
              }}
              className="w-36 px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
              placeholder="H:MM:SS"
            />
          </div>

          {/* Class type (read-only, shown only if set) */}
          {d.classType && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("classType")}</label>
              <div className="text-sm text-slate-700 py-1.5">{d.classType}</div>
            </div>
          )}

          {/* Course assignment */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-2">
              {(editCourseIds ?? d.courseIds).length > 1 ? t("coursesForked") : t("course")}
            </label>
            <CourseMultiSelect
              selectedIds={editCourseIds ?? d.courseIds}
              onChange={handleCourseChange}
            />
          </div>

          {/* Quick info */}
          {d.courseLength > 0 && (
            <div className="flex gap-4 text-xs text-slate-500">
              <span>{(d.courseLength / 1000).toFixed(1)} km</span>
              <span>{t("controlsCount", { count: d.controlCount })}</span>
              {d.firstStart > 0 && (
                <span>{t("firstStartTime", { time: formatMeosTime(d.firstStart) })}</span>
              )}
              {d.startInterval > 0 && (
                <span>{t("startIntervalSeconds", { seconds: Math.floor(d.startInterval / 10) })}</span>
              )}
            </div>
          )}
        </div>

        {/* Right: runners */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              {t("runnersCount", { count: d.runnerCount })}
            </h4>
            <button
              onClick={() => navigate(`../runners?class=${classId}`)}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
            >
              {t("viewAll")}
            </button>
          </div>
          {d.runners.length === 0 ? (
            <p className="text-sm text-slate-400">{t("noRunners")}</p>
          ) : (
            <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100 max-h-64 overflow-y-auto">
              {d.runners.slice(0, 30).map((r) => (
                <div key={r.id} className="px-4 py-1.5 flex items-center justify-between">
                  <span className="text-sm text-slate-700 truncate">{r.name}</span>
                  {r.status > 0 && (
                    <StatusDot status={r.status} />
                  )}
                </div>
              ))}
              {d.runners.length > 30 && (
                <div className="px-4 py-2 text-xs text-slate-400 text-center">
                  {t("moreRunners", { count: d.runners.length - 30 })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: number }) {
  let cls = "w-2 h-2 rounded-full shrink-0 ";
  if (status === 1) cls += "bg-green-500"; // OK
  else if (status === 3) cls += "bg-red-500"; // MP
  else if (status === 4) cls += "bg-orange-500"; // DNF
  else cls += "bg-slate-400";
  return <span className={cls} title={`Status: ${status}`} />;
}

// ─── Create class form ───────────────────────────────────────

function CreateClassForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation("classes");
  const [name, setName] = useState("");
  const [courseIds, setCourseIds] = useState<number[]>([]);
  const [sex, setSex] = useState("");
  const [sortIndex, setSortIndex] = useState("");

  const createMutation = trpc.class.create.useMutation({
    onSuccess: () => onCreated(),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      courseIds,
      sex,
      sortIndex: parseInt(sortIndex, 10) || 0,
    });
  };

  return (
    <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-900">{t("newClass")}</h3>
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
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
              required
            />
          </div>
          <div className="sm:w-28">
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("sex")}</label>
            <select
              value={sex}
              onChange={(e) => setSex(e.target.value)}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
            >
              <option value="">{t("open")}</option>
              <option value="M">{t("sexMen")}</option>
              <option value="F">{t("sexWomen")}</option>
            </select>
          </div>
          <div className="sm:w-24">
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("sortIndex")}</label>
            <input
              type="number"
              value={sortIndex}
              onChange={(e) => setSortIndex(e.target.value)}
              placeholder="0"
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-2">
            {courseIds.length > 1 ? t("coursesForked") : t("course")}
          </label>
          <CourseMultiSelect selectedIds={courseIds} onChange={setCourseIds} />
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
