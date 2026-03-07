import { useRef, useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatMeosTime, type DrawPreviewResult } from "@oxygen/shared";

const CORRIDOR_COLORS = [
  { bg: "bg-blue-400", border: "border-blue-500", text: "text-white" },
  { bg: "bg-emerald-400", border: "border-emerald-500", text: "text-white" },
  { bg: "bg-amber-400", border: "border-amber-500", text: "text-white" },
  { bg: "bg-rose-400", border: "border-rose-500", text: "text-white" },
  { bg: "bg-violet-400", border: "border-violet-500", text: "text-white" },
  { bg: "bg-cyan-400", border: "border-cyan-500", text: "text-white" },
  { bg: "bg-orange-400", border: "border-orange-500", text: "text-white" },
  { bg: "bg-teal-400", border: "border-teal-500", text: "text-white" },
  { bg: "bg-pink-400", border: "border-pink-500", text: "text-white" },
  { bg: "bg-indigo-400", border: "border-indigo-500", text: "text-white" },
];

export interface TimelineReorderEvent {
  classId: number;
  targetCorridor: number;
  targetIndex: number;
}

interface Props {
  preview: DrawPreviewResult;
  totalCorridors: number;
  onReorder: (event: TimelineReorderEvent) => void;
}

interface BarInfo {
  classId: number;
  className: string;
  courseName: string;
  corridor: number;
  startTime: number;
  endTime: number;
  runnerCount: number;
}

export function DrawTimeline({ preview, totalCorridors, onReorder }: Props) {
  const { t } = useTranslation("draw");
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{
    classId: number;
    originCorridor: number;
    hoverCorridor: number | null;
    hoverX: number;
  } | null>(null);

  const bars: BarInfo[] = useMemo(() => {
    return preview.classes
      .filter((c) => c.corridor >= 0)
      .map((cls) => {
        const lastEntry = cls.entries[cls.entries.length - 1];
        return {
          classId: cls.classId,
          className: cls.className,
          courseName: cls.courseName,
          corridor: cls.corridor,
          startTime: cls.computedFirstStart,
          endTime: lastEntry ? lastEntry.startTime : cls.computedFirstStart,
          runnerCount: cls.entries.length,
        };
      });
  }, [preview]);

  const maxUsedCorridor = useMemo(() => {
    if (bars.length === 0) return 0;
    return Math.max(...bars.map((b) => b.corridor));
  }, [bars]);

  const corridorIds = useMemo(() => {
    const count = Math.max(totalCorridors, maxUsedCorridor + 1);
    return Array.from({ length: count }, (_, i) => i);
  }, [totalCorridors, maxUsedCorridor]);

  const { minTime, maxTime } = useMemo(() => {
    if (bars.length === 0) return { minTime: 0, maxTime: 0 };
    const min = Math.min(...bars.map((b) => b.startTime));
    const max = Math.max(...bars.map((b) => b.endTime));
    const padding = Math.max((max - min) * 0.02, 600);
    return { minTime: min, maxTime: max + padding };
  }, [bars]);

  const totalRange = maxTime - minTime || 1;
  const LABEL_WIDTH = 32;

  const timeToPercent = useCallback(
    (t: number) => ((t - minTime) / totalRange) * 100,
    [minTime, totalRange],
  );

  const widthPercent = useCallback(
    (start: number, end: number) =>
      Math.max(((end - start) / totalRange) * 100, 1),
    [totalRange],
  );

  const ticks = useMemo(() => {
    const rangeSec = totalRange / 10;
    let stepSec: number;
    if (rangeSec > 7200) stepSec = 3600;
    else if (rangeSec > 3600) stepSec = 1800;
    else if (rangeSec > 1200) stepSec = 600;
    else stepSec = 300;
    const stepDs = stepSec * 10;

    const result: number[] = [];
    const first = Math.ceil(minTime / stepDs) * stepDs;
    for (let t = first; t <= maxTime; t += stepDs) {
      result.push(t);
    }
    return result;
  }, [minTime, maxTime, totalRange]);

  const barsByCorr = useMemo(() => {
    const map = new Map<number, BarInfo[]>();
    for (const id of corridorIds) map.set(id, []);
    for (const bar of bars) {
      map.get(bar.corridor)?.push(bar);
    }
    for (const [, list] of map) {
      list.sort((a, b) => a.startTime - b.startTime);
    }
    return map;
  }, [bars, corridorIds]);

  const handleDragStart = useCallback(
    (classId: number, corridor: number) => (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(classId));
      setDragState({ classId, originCorridor: corridor, hoverCorridor: null, hoverX: 0 });
    },
    [],
  );

  const handleDragOver = useCallback(
    (corridor: number) => (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      setDragState((prev) =>
        prev ? { ...prev, hoverCorridor: corridor, hoverX: x } : prev,
      );
    },
    [],
  );

  const handleDrop = useCallback(
    (corridor: number) => (e: React.DragEvent) => {
      e.preventDefault();
      const classId = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (isNaN(classId)) return;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const dropX = e.clientX - rect.left;
      const dropFraction = dropX / rect.width;
      const dropTime = minTime + dropFraction * totalRange;

      const targetBars = barsByCorr.get(corridor) ?? [];
      let targetIndex = targetBars.length;
      for (let i = 0; i < targetBars.length; i++) {
        if (targetBars[i].classId === classId) continue;
        const mid = (targetBars[i].startTime + targetBars[i].endTime) / 2;
        if (dropTime < mid) {
          targetIndex = i;
          break;
        }
      }

      onReorder({ classId, targetCorridor: corridor, targetIndex });
      setDragState(null);
    },
    [minTime, totalRange, barsByCorr, onReorder],
  );

  const handleDragEnd = useCallback(() => setDragState(null), []);

  if (bars.length === 0) return null;

  const ROW_HEIGHT = 36;

  const maxEndTime = Math.max(...bars.map((b) => b.endTime));
  const depthLabel = formatMeosTime(maxEndTime);

  return (
    <div
      ref={containerRef}
      className="space-y-0"
      data-testid="draw-timeline"
    >
      {/* Time axis */}
      <div className="flex items-end" style={{ paddingLeft: LABEL_WIDTH }}>
        <div className="relative w-full h-5">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute text-[9px] text-slate-400 tabular-nums -translate-x-1/2"
              style={{ left: `${timeToPercent(t)}%`, bottom: 0 }}
            >
              {formatMeosTime(t).slice(0, 5)}
            </span>
          ))}
        </div>
      </div>

      {/* Corridor rows */}
      {corridorIds.map((corr) => {
        const corrBars = barsByCorr.get(corr) ?? [];
        const color = CORRIDOR_COLORS[corr % CORRIDOR_COLORS.length];
        const isDropTarget = dragState?.hoverCorridor === corr;
        const isEmpty = corrBars.length === 0;

        return (
          <div
            key={corr}
            className={`flex items-center border-b border-slate-100 transition-colors ${isDropTarget ? "bg-blue-50" : isEmpty ? "bg-slate-50/40" : ""}`}
            style={{ height: ROW_HEIGHT }}
            onDragOver={handleDragOver(corr)}
            onDrop={handleDrop(corr)}
            data-testid={`timeline-corridor-${corr}`}
          >
            <span
              className={`text-[10px] font-mono shrink-0 text-right pr-1.5 ${isEmpty ? "text-slate-300" : "text-slate-400"}`}
              style={{ width: LABEL_WIDTH }}
            >
              C{corr + 1}
            </span>
            <div className="relative flex-1 h-full">
              {/* Tick lines */}
              {ticks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 bottom-0 w-px bg-slate-100"
                  style={{ left: `${timeToPercent(t)}%` }}
                />
              ))}
              {/* Depth line */}
              <div
                className="absolute top-0 bottom-0 w-px border-l border-dashed border-red-300"
                style={{ left: `${timeToPercent(maxEndTime)}%` }}
              />
              {/* Empty corridor hint */}
              {isEmpty && isDropTarget && (
                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-blue-400 pointer-events-none">
                  {t("dropHere")}
                </div>
              )}
              {/* Class bars */}
              {corrBars.map((bar) => {
                const isDragging =
                  dragState?.classId === bar.classId;
                const label = bar.courseName
                  ? `${bar.className} · ${bar.courseName}`
                  : bar.className;
                return (
                  <div
                    key={bar.classId}
                    draggable
                    onDragStart={handleDragStart(bar.classId, bar.corridor)}
                    onDragEnd={handleDragEnd}
                    className={`absolute top-1 bottom-1 rounded ${color.bg} ${color.border} border ${color.text} flex items-center px-1.5 text-[10px] font-medium cursor-grab active:cursor-grabbing select-none overflow-hidden whitespace-nowrap ${isDragging ? "opacity-40" : ""}`}
                    style={{
                      left: `${timeToPercent(bar.startTime)}%`,
                      width: `${widthPercent(bar.startTime, bar.endTime)}%`,
                      minWidth: 24,
                    }}
                    title={`${bar.className} (${bar.courseName}): ${formatMeosTime(bar.startTime)} – ${formatMeosTime(bar.endTime)} (${t("runnersTotal", { count: bar.runnerCount })})`}
                    data-testid={`timeline-bar-${bar.classId}`}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Depth label */}
      <div className="flex items-center" style={{ paddingLeft: LABEL_WIDTH }}>
        <div className="relative w-full h-4">
          <span
            className="absolute text-[9px] text-red-400 tabular-nums -translate-x-1/2"
            style={{ left: `${timeToPercent(maxEndTime)}%` }}
          >
            {depthLabel}
          </span>
        </div>
      </div>
    </div>
  );
}
