import { useState, useMemo, useCallback } from "react";
import { trpc } from "../lib/trpc";
import {
  formatMeosTime,
  parseMeosTime,
  type DrawMethod,
  type DrawPreviewResult,
  type ClassDrawConfig,
  type DrawSettings,
} from "@oxygen/shared";
import { DrawMethodHelp, CorridorTooltip, OverlapTooltip } from "./DrawHelpVisuals";
import { DrawTimeline, type TimelineReorderEvent } from "./DrawTimeline";

interface Props {
  onClose: () => void;
  onDrawComplete: () => void;
}

interface ClassConfig {
  classId: number;
  className: string;
  courseName: string;
  runnerCount: number;
  selected: boolean;
  method: DrawMethod;
  interval: string; // MM:SS format for editing
}

const DRAW_METHODS: { value: DrawMethod; label: string }[] = [
  { value: "random", label: "Random" },
  { value: "clubSeparation", label: "Club separation" },
  { value: "seeded", label: "Seeded" },
  { value: "simultaneous", label: "Simultaneous" },
];

function intervalToDeciseconds(mmss: string): number {
  return parseMeosTime(mmss);
}

function decisToInterval(ds: number): string {
  if (ds <= 0) return "2:00";
  const totalSec = Math.floor(ds / 10);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function DrawPanel({ onClose, onDrawComplete }: Props) {
  const defaults = trpc.draw.defaults.useQuery();
  const previewMutation = trpc.draw.preview.useMutation();
  const executeMutation = trpc.draw.execute.useMutation();

  const [firstStart, setFirstStart] = useState<string | null>(null);
  const [detectOverlap, setDetectOverlap] = useState(true);
  const [maxParallel, setMaxParallel] = useState(10);
  const [preview, setPreview] = useState<DrawPreviewResult | null>(null);
  const [expandedPreview, setExpandedPreview] = useState<Set<number>>(new Set());
  const [bulkMethod, setBulkMethod] = useState<DrawMethod>("clubSeparation");
  const [bulkInterval, setBulkInterval] = useState("2:00");
  const [drawComplete, setDrawComplete] = useState(false);

  const [classConfigs, setClassConfigs] = useState<ClassConfig[] | null>(null);
  const [hints, setHints] = useState<Map<number, { corridor?: number; order?: number }>>(new Map());

  // Initialize class configs from defaults
  const configs = useMemo(() => {
    if (classConfigs) return classConfigs;
    if (!defaults.data) return [];

    return defaults.data.classes
      .filter((c) => c.runnerCount > 0)
      .map(
        (c): ClassConfig => ({
          classId: c.id,
          className: c.name,
          courseName: c.courseName,
          runnerCount: c.runnerCount,
          selected: !c.freeStart,
          method: "clubSeparation",
          interval: c.startInterval > 0 ? decisToInterval(c.startInterval) : "2:00",
        }),
      );
  }, [classConfigs, defaults.data]);

  const defaultFirstStart = useMemo(() => {
    if (!defaults.data) return "09:00:00";
    return formatMeosTime(defaults.data.zeroTime);
  }, [defaults.data]);

  const selectedCount = configs.filter((c) => c.selected).length;
  const totalRunners = configs
    .filter((c) => c.selected)
    .reduce((sum, c) => sum + c.runnerCount, 0);

  const updateConfig = useCallback(
    (classId: number, update: Partial<ClassConfig>) => {
      setClassConfigs(
        (configs.map((c) =>
          c.classId === classId ? { ...c, ...update } : c,
        )),
      );
      setPreview(null);
      setHints(new Map());
    },
    [configs],
  );

  const toggleAll = useCallback(
    (selected: boolean) => {
      setClassConfigs(configs.map((c) => ({ ...c, selected })));
      setPreview(null);
      setHints(new Map());
    },
    [configs],
  );

  const applyBulkMethod = useCallback(() => {
    setClassConfigs(
      configs.map((c) => (c.selected ? { ...c, method: bulkMethod } : c)),
    );
    setPreview(null);
    setHints(new Map());
  }, [configs, bulkMethod]);

  const applyBulkInterval = useCallback(() => {
    setClassConfigs(
      configs.map((c) => (c.selected ? { ...c, interval: bulkInterval } : c)),
    );
    setPreview(null);
    setHints(new Map());
  }, [configs, bulkInterval]);

  const buildInput = useCallback((): {
    classes: ClassDrawConfig[];
    settings: DrawSettings;
  } => {
    const selected = configs.filter((c) => c.selected);
    return {
      classes: selected.map((c) => {
        const h = hints.get(c.classId);
        return {
          classId: c.classId,
          method: c.method,
          interval: intervalToDeciseconds(c.interval),
          corridorHint: h?.corridor,
          orderHint: h?.order,
        };
      }),
      settings: {
        firstStart: parseMeosTime(firstStart ?? defaultFirstStart),
        baseInterval: 600,
        maxParallelStarts: maxParallel,
        detectCourseOverlap: detectOverlap,
      },
    };
  }, [configs, firstStart, defaultFirstStart, maxParallel, detectOverlap, hints]);

  const handlePreview = useCallback(() => {
    const input = buildInput();
    if (input.classes.length === 0) return;
    previewMutation.mutate(input, {
      onSuccess: (data) => {
        setPreview(data);
        setExpandedPreview(new Set(data.classes.map((c) => c.classId)));
      },
    });
  }, [buildInput, previewMutation]);

  const handleTimelineReorder = useCallback(
    (event: TimelineReorderEvent) => {
      if (!preview) return;
      // Build new hints: assign corridor and order for all classes based on
      // current preview positions, with the dragged class moved.
      const newHints = new Map<number, { corridor?: number; order?: number }>();

      // Group current preview classes by corridor
      const byCorridor = new Map<number, number[]>();
      for (const cls of preview.classes) {
        if (cls.corridor < 0) continue;
        const list = byCorridor.get(cls.corridor) ?? [];
        list.push(cls.classId);
        byCorridor.set(cls.corridor, list);
      }

      // Remove the dragged class from its old position
      for (const [cor, list] of byCorridor) {
        byCorridor.set(cor, list.filter((id) => id !== event.classId));
      }

      // Insert into target corridor at target index
      const targetList = byCorridor.get(event.targetCorridor) ?? [];
      const insertIdx = Math.min(event.targetIndex, targetList.length);
      targetList.splice(insertIdx, 0, event.classId);
      byCorridor.set(event.targetCorridor, targetList);

      // Set hints for all classes
      for (const [cor, list] of byCorridor) {
        for (let i = 0; i < list.length; i++) {
          newHints.set(list[i], { corridor: cor, order: i });
        }
      }

      setHints(newHints);

      // Re-preview with new hints
      const selected = configs.filter((c) => c.selected);
      const input = {
        classes: selected.map((c) => {
          const h = newHints.get(c.classId);
          return {
            classId: c.classId,
            method: c.method,
            interval: intervalToDeciseconds(c.interval),
            corridorHint: h?.corridor,
            orderHint: h?.order,
          };
        }),
        settings: {
          firstStart: parseMeosTime(firstStart ?? defaultFirstStart),
          baseInterval: 600,
          maxParallelStarts: maxParallel,
          detectCourseOverlap: detectOverlap,
        },
      };
      previewMutation.mutate(input, {
        onSuccess: (data) => {
          setPreview(data);
          setExpandedPreview(new Set(data.classes.map((c) => c.classId)));
        },
      });
    },
    [preview, configs, firstStart, defaultFirstStart, maxParallel, detectOverlap, previewMutation],
  );

  const handleExecute = useCallback(() => {
    const input = buildInput();
    if (input.classes.length === 0) return;
    executeMutation.mutate(input, {
      onSuccess: () => {
        setDrawComplete(true);
        onDrawComplete();
      },
    });
  }, [buildInput, executeMutation, onDrawComplete]);

  const togglePreviewClass = (classId: number) => {
    setExpandedPreview((prev) => {
      const next = new Set(prev);
      if (next.has(classId)) next.delete(classId);
      else next.add(classId);
      return next;
    });
  };

  if (defaults.isLoading) {
    return (
      <div className="fixed inset-y-0 right-0 w-full max-w-6xl bg-white shadow-2xl border-l border-slate-200 z-50 flex items-center justify-center">
        <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (defaults.isError) {
    return (
      <div className="fixed inset-y-0 right-0 w-full max-w-6xl bg-white shadow-2xl border-l border-slate-200 z-50 flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-red-600 text-sm" data-testid="draw-error">
          Failed to load draw settings: {defaults.error?.message}
        </p>
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-white shadow-2xl z-50 flex flex-col" data-testid="draw-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Draw Start Times</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {selectedCount} class{selectedCount !== 1 ? "es" : ""} selected
            {" \u00b7 "}
            {totalRunners} runner{totalRunners !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
          aria-label="Close draw panel"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Global Settings */}
        <div className="px-6 py-4 border-b border-slate-100">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Global Settings
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">
                First start
              </label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="09:00:00"
                value={firstStart ?? defaultFirstStart}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d:]/g, "");
                  setFirstStart(v);
                  setPreview(null);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
              />
            </div>
            <div>
              <label className="flex items-center gap-1 text-xs font-medium text-slate-500 mb-1">
                Max corridors
                <CorridorTooltip />
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={maxParallel}
                onChange={(e) => {
                  setMaxParallel(parseInt(e.target.value, 10) || 10);
                  setPreview(null);
                }}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={detectOverlap}
                  onChange={(e) => {
                    setDetectOverlap(e.target.checked);
                    setPreview(null);
                  }}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
                <span className="text-sm text-slate-600 inline-flex items-center gap-1">
                  Course overlap
                  <OverlapTooltip />
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* Class Configuration */}
        <div className="px-6 py-4 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Classes
            </h3>
            <div className="flex items-center gap-2">
              <select
                value={bulkMethod}
                onChange={(e) => setBulkMethod(e.target.value as DrawMethod)}
                className="px-2 py-1 border border-slate-200 rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                data-testid="draw-bulk-method"
              >
                {DRAW_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <button
                onClick={applyBulkMethod}
                className="px-2 py-1 text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors cursor-pointer font-medium"
              >
                Apply
              </button>
              <span className="text-slate-300 mx-1">|</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="2:00"
                value={bulkInterval}
                onChange={(e) => setBulkInterval(e.target.value.replace(/[^\d:]/g, ""))}
                className="w-14 px-2 py-1 border border-slate-200 rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"
                data-testid="draw-bulk-interval"
              />
              <button
                onClick={applyBulkInterval}
                className="px-2 py-1 text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors cursor-pointer font-medium"
                data-testid="draw-bulk-interval-apply"
              >
                Apply
              </button>
              <span className="text-slate-300 mx-1">|</span>
              <button
                onClick={() => toggleAll(true)}
                className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer"
              >
                All
              </button>
              <button
                onClick={() => toggleAll(false)}
                className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer"
              >
                None
              </button>
            </div>
          </div>

          <DrawMethodHelp />

          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="w-8 px-2 py-2"></th>
                  <th className="px-3 py-2 text-left font-medium text-slate-500 text-xs">Class</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-500 text-xs hidden sm:table-cell">Course</th>
                  <th className="px-3 py-2 text-right font-medium text-slate-500 text-xs w-16">Runners</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-500 text-xs">Method</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-500 text-xs w-24">Interval</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {configs.map((c) => (
                  <tr
                    key={c.classId}
                    className={`transition-colors ${c.selected ? "" : "opacity-40"}`}
                  >
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={c.selected}
                        onChange={(e) => updateConfig(c.classId, { selected: e.target.checked })}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        data-testid={`draw-class-${c.classId}`}
                      />
                    </td>
                    <td className="px-3 py-1.5 font-medium text-slate-700">
                      {c.className}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500 hidden sm:table-cell">
                      {c.courseName || "\u2014"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">
                      {c.runnerCount}
                    </td>
                    <td className="px-3 py-1.5">
                      <select
                        value={c.method}
                        onChange={(e) => updateConfig(c.classId, { method: e.target.value as DrawMethod })}
                        disabled={!c.selected}
                        className="w-full px-2 py-1 border border-slate-200 rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer disabled:opacity-50"
                      >
                        {DRAW_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="2:00"
                        value={c.interval}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^\d:]/g, "");
                          updateConfig(c.classId, { interval: v });
                        }}
                        disabled={!c.selected || c.method === "simultaneous"}
                        className="w-20 px-2 py-1 border border-slate-200 rounded text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums disabled:opacity-50"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Warnings */}
        {preview && preview.warnings.length > 0 && (
          <div className="px-6 py-3 bg-amber-50 border-b border-amber-100">
            <div className="flex items-start gap-2">
              <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <div className="text-xs text-amber-800 space-y-0.5">
                {preview.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Preview Results */}
        {preview && (
          <div className="px-6 py-4">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Preview
            </h3>
            <div className="mb-4 border border-slate-200 rounded-lg p-3 bg-slate-50/50">
              <DrawTimeline
                preview={preview}
                totalCorridors={maxParallel}
                onReorder={handleTimelineReorder}
              />
              <p className="text-[10px] text-slate-400 mt-1.5 text-center">
                Drag class bars to reorder within or across corridors
              </p>
            </div>
            <div className="space-y-2">
              {preview.classes.map((cls) => (
                <div key={cls.classId} className="border border-slate-200 rounded-lg overflow-hidden">
                  <button
                    onClick={() => togglePreviewClass(cls.classId)}
                    className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-sm text-slate-700">
                        {cls.className}
                      </span>
                      <span className="text-xs text-slate-400">
                        {cls.entries.length} runners
                      </span>
                      {cls.corridor >= 0 && (
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
                          Corridor {cls.corridor + 1}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500 tabular-nums">
                        {formatMeosTime(cls.computedFirstStart)}
                        {cls.entries.length > 1 && (
                          <> &ndash; {formatMeosTime(cls.entries[cls.entries.length - 1].startTime)}</>
                        )}
                      </span>
                      <svg
                        className={`w-4 h-4 text-slate-400 transition-transform ${
                          expandedPreview.has(cls.classId) ? "rotate-180" : ""
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>
                  {expandedPreview.has(cls.classId) && (
                    <table className="w-full text-xs">
                      <tbody className="divide-y divide-slate-100">
                        {cls.entries.map((entry) => (
                          <tr key={entry.runnerId} className="hover:bg-slate-50">
                            <td className="px-4 py-1.5 tabular-nums text-slate-400 w-12">
                              {entry.startNo}
                            </td>
                            <td className="px-4 py-1.5 tabular-nums font-medium text-slate-700 w-20">
                              {formatMeosTime(entry.startTime)}
                            </td>
                            <td className="px-4 py-1.5 text-slate-700">
                              {entry.name}
                            </td>
                            <td className="px-4 py-1.5 text-slate-500 text-right">
                              {entry.clubName}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Success message */}
        {drawComplete && (
          <div className="px-6 py-4">
            <div className="flex items-center gap-2 p-4 bg-green-50 border border-green-200 rounded-lg">
              <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div>
                <p className="text-sm font-medium text-green-800">
                  Draw complete
                </p>
                <p className="text-xs text-green-600 mt-0.5">
                  {executeMutation.data?.totalDrawn} runner{(executeMutation.data?.totalDrawn ?? 0) !== 1 ? "s" : ""} assigned start times.
                  The start list has been updated.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sticky footer */}
      <div className="px-6 py-4 border-t border-slate-200 bg-white flex items-center justify-between gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
        >
          {drawComplete ? "Close" : "Cancel"}
        </button>
        <div className="flex items-center gap-2">
          {!drawComplete && (
            <>
              <button
                onClick={handlePreview}
                disabled={selectedCount === 0 || previewMutation.isPending}
                className="px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="draw-preview-btn"
              >
                {previewMutation.isPending ? "Generating..." : "Preview"}
              </button>
              <button
                onClick={handleExecute}
                disabled={!preview || executeMutation.isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="draw-execute-btn"
              >
                {executeMutation.isPending ? "Applying..." : "Apply Draw"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error display */}
      {(previewMutation.isError || executeMutation.isError) && (
        <div className="px-6 py-3 bg-red-50 border-t border-red-200 text-sm text-red-700">
          {previewMutation.error?.message || executeMutation.error?.message}
        </div>
      )}
    </div>
  );
}
