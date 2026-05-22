import { useMemo, useState, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Brush,
} from "recharts";
import { trpc } from "../lib/trpc";
import {
  buildSeries,
  daysToGo,
  type RawEntry,
  type SeriesPoint,
  type XAxisMode,
  type YAxisMode,
} from "../lib/registration-trends";
import { ComparisonPickerDialog } from "../components/ComparisonPickerDialog";

const SERIES_COLOURS = [
  "#0ea5e9", // sky-500 — own competition
  "#f97316", // orange-500
  "#10b981", // emerald-500
  "#a855f7", // purple-500
  "#ef4444", // red-500
  "#14b8a6", // teal-500
  "#eab308", // yellow-500
  "#6366f1", // indigo-500
];

interface ComparisonSelection {
  id: number;
  name: string;
  date: string;
  organiserName: string;
}

export function RegistrationTrendsPage() {
  const { t } = useTranslation("trends");
  const [searchParams, setSearchParams] = useSearchParams();
  const [xAxis, setXAxis] = useState<XAxisMode>(
    (searchParams.get("x") as XAxisMode) || "daysBefore",
  );
  const [yAxis, setYAxis] = useState<YAxisMode>(
    (searchParams.get("y") as YAxisMode) || "cumulative",
  );
  const [classFilter, setClassFilter] = useState<number[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  const ownTimeline = trpc.registrationTrends.ownTimeline.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  // Comparison events selected by the user (persisted in URL).
  const [comparisons, setComparisons] = useState<ComparisonSelection[]>(() => {
    const raw = searchParams.get("cmp");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as ComparisonSelection[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  // Cached comparison data, keyed by event id.
  type ComparisonEntry = {
    entries: RawEntry[];
    eventDate: string;
    error?: string;
  };
  const [comparisonData, setComparisonData] = useState<
    Record<number, ComparisonEntry>
  >({});

  const fetchComparison = trpc.registrationTrends.fetchComparison.useMutation();
  const fetchEntryHistory =
    trpc.eventor.fetchEntryHistory.useMutation();

  const loadComparison = useCallback(
    async (selections: ComparisonSelection[], force = false) => {
      if (selections.length === 0) return;

      // 1) Read whatever's in the cache today.
      const initial = await fetchComparison.mutateAsync({
        eventIds: selections.map((s) => s.id),
        eventMeta: selections.map((s) => ({
          id: s.id,
          startDate: s.date,
          name: s.name,
          organiserName: s.organiserName,
        })),
        force,
      });

      // 2) Decide which ids need a live Eventor refetch. On a force
      //    refresh we refetch everything; otherwise we only chase
      //    rows that came back as "missing" so the page doesn't hit
      //    Eventor on every click.
      const idsToFetch = force
        ? selections.map((s) => s.id)
        : initial.events
            .filter((e) => e.error === "missing")
            .map((e) => e.eventId);

      let final = initial;
      if (idsToFetch.length > 0) {
        try {
          await fetchEntryHistory.mutateAsync({ eventIds: idsToFetch, force });
          // Re-read the cache after the sync so the page picks up the
          // freshly-populated rows.
          final = await fetchComparison.mutateAsync({
            eventIds: selections.map((s) => s.id),
            eventMeta: selections.map((s) => ({
              id: s.id,
              startDate: s.date,
              name: s.name,
              organiserName: s.organiserName,
            })),
          });
        } catch (err) {
          // Auth / config errors surface as a trpc error — fall
          // through and let the per-event `error: "missing"` markers
          // tell the user what happened. We don't want to fail the
          // whole page render here; the operator can re-try once
          // they've configured an Eventor key.
          console.warn("[trends] fetchEntryHistory failed:", err);
        }
      }

      setComparisonData((prev) => {
        const next = { ...prev };
        for (const r of final.events) {
          const sel = selections.find((s) => s.id === r.eventId);
          next[r.eventId] = {
            entries: r.entries.map((e) => ({ at: e.at, classId: e.classId })),
            eventDate: sel?.date ?? r.meta?.startDate ?? "",
            ...(r.error ? { error: r.error } : {}),
          };
        }
        return next;
      });
    },
    [fetchComparison, fetchEntryHistory],
  );

  // Fetch entry timelines for any newly-added comparison events.
  useEffect(() => {
    const missing = comparisons.filter((c) => !comparisonData[c.id]);
    if (missing.length > 0) {
      void loadComparison(missing);
    }
  }, [comparisons, comparisonData, loadComparison]);

  // Persist axis mode + comparison selection to URL params.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.set("x", xAxis);
    next.set("y", yAxis);
    if (comparisons.length > 0) {
      next.set("cmp", JSON.stringify(comparisons));
    } else {
      next.delete("cmp");
    }
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xAxis, yAxis, comparisons]);

  // Build merged chart data: one row per unique x value, one column per series.
  const chartData = useMemo(() => {
    if (!ownTimeline.data) return [] as Record<string, number | null>[];

    const classSet = classFilter.length > 0 ? new Set(classFilter) : undefined;

    const ownPoints = buildSeries(ownTimeline.data.entries, {
      xAxis,
      yAxis,
      eventDate: ownTimeline.data.event.date,
      ...(classSet ? { classIds: classSet } : {}),
    });

    const series: { key: string; points: SeriesPoint[] }[] = [
      { key: "own", points: ownPoints },
    ];
    for (const cmp of comparisons) {
      const data = comparisonData[cmp.id];
      if (!data) continue;
      // Use the picker's race date (cmp.date) — it's authoritative and
      // always populated, whereas the cached data.eventDate may be wrong
      // for legacy rows written before the cache stored race-date meta.
      const pts = buildSeries(data.entries, {
        xAxis,
        yAxis,
        eventDate: cmp.date || data.eventDate,
      });
      series.push({ key: `cmp-${cmp.id}`, points: pts });
    }

    // Merge by x-coordinate so each row contains all series values that
    // share that x. For cumulative + date axis we also forward-fill so
    // the line doesn't drop to null between own-entries and comparisons.
    const xValues = new Set<number>();
    for (const s of series) for (const p of s.points) xValues.add(p.x);
    const sortedXs = [...xValues].sort((a, b) => a - b);

    const lastByKey: Record<string, number | null> = {};
    const merged: Record<string, number | null>[] = [];
    for (const x of sortedXs) {
      const row: Record<string, number | null> = { x };
      for (const s of series) {
        const point = s.points.find((p) => p.x === x);
        if (point) {
          row[s.key] = point.y;
          lastByKey[s.key] = point.y;
        } else if (yAxis === "cumulative") {
          // Forward-fill cumulative series for visual continuity
          row[s.key] = lastByKey[s.key] ?? null;
        } else {
          row[s.key] = null;
        }
      }
      merged.push(row);
    }
    return merged;
  }, [ownTimeline.data, comparisons, comparisonData, xAxis, yAxis, classFilter]);

  if (ownTimeline.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!ownTimeline.data) return null;

  const data = ownTimeline.data;
  const dtg = daysToGo(data.event.date);
  const eventLabel =
    dtg > 0
      ? t("daysToGo") + ": " + dtg
      : dtg === 0
        ? t("raceDay")
        : t("raceDayPast", { days: -dtg });

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{t("title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <Stat label={t("raceDate")} value={data.event.date} />
            <Stat label={t("totalEntries")} value={String(data.totalRunners)} />
            <Stat label={t("datedEntries")} value={String(data.datedCount)} />
            <Stat label={eventLabel} value="" emphasised />
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center gap-4">
          <SegmentedControl
            label={t("xAxis")}
            value={xAxis}
            onChange={(v) => setXAxis(v as XAxisMode)}
            options={[
              { value: "daysBefore", label: t("xAxisDaysBefore") },
              { value: "date", label: t("xAxisDate") },
            ]}
          />
          <SegmentedControl
            label={t("yAxis")}
            value={yAxis}
            onChange={(v) => setYAxis(v as YAxisMode)}
            options={[
              { value: "cumulative", label: t("yAxisCumulative") },
              { value: "perDay", label: t("yAxisPerDay") },
            ]}
          />
          <ClassFilter
            value={classFilter}
            onChange={setClassFilter}
            classes={data.classes}
            allLabel={t("allClasses")}
            label={t("filterByClass")}
          />
          <button
            onClick={() => setShowPicker(true)}
            className="ml-auto px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
          >
            {t("addComparison")}
          </button>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        {data.entries.length === 0 ? (
          <p className="text-sm text-slate-500 py-12 text-center">
            {t("noData")}
          </p>
        ) : (
          <div style={{ width: "100%", height: 480 }}>
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => formatXTick(v, xAxis)}
                  reversed={xAxis === "daysBefore"}
                  stroke="#64748b"
                  fontSize={12}
                />
                <YAxis
                  stroke="#64748b"
                  fontSize={12}
                  allowDecimals={false}
                  label={{
                    value: yAxis === "cumulative" ? t("axisEntriesCumulative") : t("axisEntriesPerDay"),
                    angle: -90,
                    position: "insideLeft",
                    fontSize: 11,
                    fill: "#64748b",
                  }}
                />
                <Tooltip
                  labelFormatter={(label) =>
                    formatXTooltip(Number(label), xAxis, (key, opts) =>
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      (t as any)(key, opts) as string,
                    )
                  }
                  formatter={(value, name) => [
                    t("tooltipEntries", { count: Number(value) }),
                    seriesLabel(String(name), comparisons, t("thisCompetition")),
                  ]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend
                  formatter={(value) =>
                    seriesLabel(String(value), comparisons, t("thisCompetition"))
                  }
                  wrapperStyle={{ fontSize: 12 }}
                />
                <Brush
                  dataKey="x"
                  height={20}
                  stroke="#94a3b8"
                  tickFormatter={(v: number) => formatXTick(v, xAxis)}
                />
                {/* Own series */}
                <Line
                  type="monotone"
                  dataKey="own"
                  stroke={SERIES_COLOURS[0]}
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={yAxis === "cumulative"}
                />
                {/* Comparison series */}
                {comparisons.map((cmp, idx) => (
                  <Line
                    key={cmp.id}
                    type="monotone"
                    dataKey={`cmp-${cmp.id}`}
                    stroke={SERIES_COLOURS[(idx + 1) % SERIES_COLOURS.length]}
                    strokeWidth={1.75}
                    strokeDasharray="6 3"
                    dot={false}
                    isAnimationActive={false}
                    connectNulls={yAxis === "cumulative"}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Comparison list */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
            {t("comparisonEvents")}
          </h2>
          {comparisons.length > 0 && (
            <button
              onClick={() => loadComparison(comparisons, true)}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
              disabled={fetchComparison.isPending || fetchEntryHistory.isPending}
            >
              {fetchComparison.isPending || fetchEntryHistory.isPending
                ? t("refreshing")
                : t("refresh")}
            </button>
          )}
        </div>
        {comparisons.length === 0 ? (
          <p className="text-sm text-slate-500">{t("noComparisonEvents")}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {comparisons.map((cmp, idx) => {
              const colour = SERIES_COLOURS[(idx + 1) % SERIES_COLOURS.length];
              const cmpData = comparisonData[cmp.id];
              return (
                <li
                  key={cmp.id}
                  className="flex items-center justify-between py-2"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                      style={{ background: colour }}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">
                        {cmp.name}
                      </div>
                      <div className="text-xs text-slate-500 truncate">
                        {cmp.date}
                        {cmp.organiserName ? " · " + cmp.organiserName : ""}
                        {cmpData?.error
                          ? " · " + t("comparisonError", { message: cmpData.error })
                          : ""}
                        {!cmpData &&
                        (fetchComparison.isPending || fetchEntryHistory.isPending)
                          ? " · " + t("loading")
                          : ""}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      setComparisons((prev) => prev.filter((c) => c.id !== cmp.id))
                    }
                    className="text-xs text-slate-500 hover:text-red-600 px-2 py-1 cursor-pointer"
                  >
                    {t("remove")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {showPicker && (
        <ComparisonPickerDialog
          eventDate={data.event.date}
          alreadySelected={new Set(comparisons.map((c) => c.id))}
          onClose={() => setShowPicker(false)}
          onConfirm={(selected) => {
            setComparisons((prev) => [
              ...prev,
              ...selected.filter(
                (s) => !prev.some((p) => p.id === s.id),
              ),
            ]);
            setShowPicker(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────

function Stat({
  label,
  value,
  emphasised,
}: {
  label: string;
  value: string;
  emphasised?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wider text-slate-500">
        {label}
      </span>
      {value && (
        <span
          className={`font-semibold ${emphasised ? "text-blue-700" : "text-slate-900"}`}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function SegmentedControl({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">
        {label}
      </span>
      <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1.5 text-xs font-medium cursor-pointer ${
              value === opt.value
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ClassFilter({
  value,
  onChange,
  classes,
  allLabel,
  label,
}: {
  value: number[];
  onChange: (v: number[]) => void;
  classes: { id: number; name: string }[];
  allLabel: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? classes.find((c) => c.id === value[0])?.name ?? allLabel
        : `${value.length} selected`;
  return (
    <div className="relative">
      <span className="text-xs font-medium text-slate-500 uppercase tracking-wider mr-2">
        {label}
      </span>
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
      >
        {summary}
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setOpen(false)}
          />
          <div className="absolute z-30 mt-1 left-0 max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg w-56">
            <button
              onClick={() => onChange([])}
              className={`w-full text-left px-3 py-1.5 text-xs cursor-pointer ${value.length === 0 ? "bg-blue-50 text-blue-700 font-medium" : "hover:bg-slate-50"}`}
            >
              {allLabel}
            </button>
            <div className="border-t border-slate-100" />
            {classes.map((c) => {
              const selected = value.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() =>
                    onChange(
                      selected
                        ? value.filter((id) => id !== c.id)
                        : [...value, c.id],
                    )
                  }
                  className={`w-full text-left px-3 py-1.5 text-xs cursor-pointer flex items-center gap-2 ${selected ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    readOnly
                    className="pointer-events-none"
                  />
                  <span>{c.name}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Formatters ─────────────────────────────────────────────

function formatXTick(v: number, mode: XAxisMode): string {
  if (mode === "daysBefore") {
    if (v === 0) return "0";
    return `${v > 0 ? "−" : "+"}${Math.abs(Math.round(v))}d`;
  }
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${m}/${day}`;
}

function formatXTooltip(
  v: number,
  mode: XAxisMode,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (mode === "daysBefore") {
    return t("tooltipDayLabel", { day: Math.round(v) });
  }
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString();
}

function seriesLabel(
  key: string,
  comparisons: ComparisonSelection[],
  ownLabel: string,
): string {
  if (key === "own") return ownLabel;
  if (key.startsWith("cmp-")) {
    const id = parseInt(key.slice(4), 10);
    return comparisons.find((c) => c.id === id)?.name ?? key;
  }
  return key;
}
