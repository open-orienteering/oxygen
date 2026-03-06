import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { formatMeosTime, type ClassSummary } from "@oxygen/shared";
import { useSearchParam, useNumericSearchParam } from "../hooks/useSearchParam";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
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
  const [search, setSearch] = useSearchParam("search");
  const [expandedId, setExpandedId] = useNumericSearchParam("classId");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const utils = trpc.useUtils();

  const classes = trpc.class.list.useQuery({
    search: search || undefined,
  });

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
    if (window.confirm(`Remove class "${name}"?`)) {
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
            placeholder="Search class or course name..."
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
          New Class
        </button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-500">
          {items.length} class{items.length !== 1 ? "es" : ""}
          {!isFiltered && items.length > 1 && (
            <span className="text-slate-400 ml-2">· drag to reorder</span>
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
            No classes found
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
              disabled={isFiltered}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      {!isFiltered && (
                        <th className="w-10 px-1 py-2.5" />
                      )}
                      <SortHeader label="Name" active={isFiltered ? sort.key === "name" : undefined} direction={sort.dir} onClick={() => toggle("name")} />
                      <SortHeader label="Course" active={isFiltered ? sort.key === "course" : undefined} direction={sort.dir} onClick={() => toggle("course")} />
                      <SortHeader label="Runners" active={isFiltered ? sort.key === "runners" : undefined} direction={sort.dir} onClick={() => toggle("runners")} className="w-24" />
                      <SortHeader label="Fee" active={isFiltered ? sort.key === "fee" : undefined} direction={sort.dir} onClick={() => toggle("fee")} className="hidden sm:table-cell w-20" />
                      <SortHeader label="Sex" active={isFiltered ? sort.key === "sex" : undefined} direction={sort.dir} onClick={() => toggle("sex")} className="hidden md:table-cell w-24" />
                      <SortHeader label="Type" active={isFiltered ? sort.key === "type" : undefined} direction={sort.dir} onClick={() => toggle("type")} className="hidden lg:table-cell" />
                      <th className="px-4 py-2.5 text-left font-medium text-slate-500 hidden xl:table-cell w-32">Options</th>
                      <th className="px-4 py-2.5 text-right font-medium text-slate-500 w-20">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((cls) => (
                      <SortableClassRow
                        key={cls.id}
                        cls={cls}
                        isExpanded={expandedId === cls.id}
                        isFiltered={isFiltered}
                        onToggleExpand={() => handleToggleExpand(cls.id)}
                        onDelete={() => handleDelete(cls.id, cls.name)}
                        colSpan={isFiltered ? 6 : 7}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Map */}
      <MapPanel
        className="mt-6"
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
  onToggleExpand,
  onDelete,
  colSpan,
}: {
  cls: ClassSummary;
  isExpanded: boolean;
  isFiltered: boolean;
  onToggleExpand: () => void;
  onDelete: () => void;
  colSpan: number;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cls.id, disabled: isFiltered });

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
          isExpanded ? "bg-blue-50" : "hover:bg-slate-50"
        } ${isDragging ? "shadow-lg bg-white" : ""}`}
        onClick={onToggleExpand}
      >
        {!isFiltered && (
          <td
            className="w-10 px-1 py-2.5 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="p-1 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing touch-none"
              aria-label="Drag to reorder"
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
                Forked
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
          {formatSex(cls.sex)}
        </td>
        <td className="px-4 py-2.5 text-slate-500 hidden lg:table-cell text-xs">
          {cls.classType || "—"}
        </td>
        <td className="px-4 py-2.5 hidden xl:table-cell">
          <div className="flex gap-1.5">
            {cls.freeStart && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                Free start
              </span>
            )}
            {cls.noTiming && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                No timing
              </span>
            )}
            {!cls.freeStart && !cls.noTiming && (
              <span className="text-slate-300">—</span>
            )}
          </div>
        </td>
        <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onDelete}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors cursor-pointer"
            title="Remove class"
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

function formatSex(sex: string): string {
  if (sex === "M") return "Men";
  if (sex === "F" || sex === "W") return "Women";
  return "Open";
}

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
            {c.controlCount} controls
            {c.length > 0 && ` · ${(c.length / 1000).toFixed(1)} km`}
          </span>
        </label>
      ))}
      {available.length === 0 && (
        <p className="text-xs text-slate-400">No courses available</p>
      )}
      {selectedIds.length > 1 && (
        <p className="text-xs text-purple-600 font-medium mt-1">
          Forked — runners will be assigned different courses
        </p>
      )}
    </div>
  );
}

// ─── Inline detail (expanded view) ──────────────────────────

function ClassInlineDetail({ classId }: { classId: number }) {
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
        Class not found
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
            Class Settings
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
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
              <label className="block text-xs font-medium text-slate-500 mb-1">Sex</label>
              <select
                value={editSex ?? d.sex}
                onChange={(e) => {
                  setEditSex(e.target.value);
                  handleSave("sex", e.target.value);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="">Open (any)</option>
                <option value="M">Men</option>
                <option value="F">Women</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Sort Index</label>
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

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {d.classType && (
              <div className="col-span-2 sm:col-span-4">
                <label className="block text-xs font-medium text-slate-500 mb-1">Class Type</label>
                <div className="text-sm text-slate-700 py-1.5">{d.classType}</div>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Min Age</label>
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
              <label className="block text-xs font-medium text-slate-500 mb-1">Max Age</label>
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
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer pb-1.5">
                <input
                  type="checkbox"
                  checked={d.freeStart}
                  onChange={(e) => handleSave("freeStart", e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
                <span className="text-sm text-slate-600">Free start</span>
              </label>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer pb-1.5">
                <input
                  type="checkbox"
                  checked={d.noTiming}
                  onChange={(e) => handleSave("noTiming", e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
                <span className="text-sm text-slate-600">No timing</span>
              </label>
            </div>
          </div>

          {/* Entry fee */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Entry fee (kr)</label>
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
              className="w-32 px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
              min={0}
              placeholder="0"
            />
          </div>

          {/* Course assignment */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-2">
              Course{(editCourseIds ?? d.courseIds).length > 1 ? "s (forked)" : ""}
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
              <span>{d.controlCount} controls</span>
              {d.firstStart > 0 && (
                <span>First start: {formatMeosTime(d.firstStart)}</span>
              )}
              {d.startInterval > 0 && (
                <span>Interval: {Math.floor(d.startInterval / 10)}s</span>
              )}
            </div>
          )}
        </div>

        {/* Right: runners */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Runners ({d.runnerCount})
            </h4>
            <button
              onClick={() => navigate(`../runners?class=${classId}`)}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
            >
              View all
            </button>
          </div>
          {d.runners.length === 0 ? (
            <p className="text-sm text-slate-400">No runners in this class</p>
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
                  +{d.runners.length - 30} more
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
        <h3 className="text-sm font-semibold text-slate-900">New Class</h3>
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
            <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. H21"
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
              required
            />
          </div>
          <div className="sm:w-28">
            <label className="block text-xs font-medium text-slate-500 mb-1">Sex</label>
            <select
              value={sex}
              onChange={(e) => setSex(e.target.value)}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
            >
              <option value="">Open</option>
              <option value="M">Men</option>
              <option value="F">Women</option>
            </select>
          </div>
          <div className="sm:w-24">
            <label className="block text-xs font-medium text-slate-500 mb-1">Sort Index</label>
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
            Course{courseIds.length > 1 ? "s (forked)" : ""}
          </label>
          <CourseMultiSelect selectedIds={courseIds} onChange={setCourseIds} />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={createMutation.isPending || !name.trim()}
            className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-slate-500 text-sm hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          >
            Cancel
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
