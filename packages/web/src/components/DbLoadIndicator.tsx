import { useState, useEffect, useRef } from "react";
import { trpc } from "../lib/trpc";
import { usePageVisible } from "../hooks/usePageVisible";
import { usePerformanceSensitive } from "../lib/performance-mode";

const POLL_MS = 3_000;
const HISTORY_LEN = 20;

/**
 * Cumulative DB counters as returned by `competition.dbStatus`. The
 * client polls every `POLL_MS` and differences successive snapshots
 * to derive rates (transactions/sec, tuples/sec).
 */
interface DbStatus {
  backends: number;
  activeBackends: number;
  xactCommit: number;
  xactRollback: number;
  tupReturned: number;
  tupFetched: number;
  tupInserted: number;
  tupUpdated: number;
  tupDeleted: number;
  blksRead: number;
  blksHit: number;
  deadlocks: number;
  tempBytes: number;
  dbSizeBytes: number;
  statsReset: string | null;
}

interface RateSnapshot {
  /** Transactions per second (commit + rollback). The "qps" headline. */
  tps: number;
  insertsPerSec: number;
  updatesPerSec: number;
  deletesPerSec: number;
  tupReturnedPerSec: number;
  blksReadPerSec: number;
  cacheHitRatio: number;
  rollbackRatio: number;
  backends: number;
  activeBackends: number;
  deadlocks: number;
  dbSizeBytes: number;
  statsResetAgoMs: number | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function tpsColor(tps: number): string {
  if (tps < 10) return "text-emerald-600";
  if (tps < 50) return "text-blue-600";
  if (tps < 200) return "text-amber-600";
  return "text-red-600";
}

function tpsBgColor(tps: number): string {
  if (tps < 10) return "bg-emerald-50";
  if (tps < 50) return "bg-blue-50";
  if (tps < 200) return "bg-amber-50";
  return "bg-red-50";
}

/**
 * Tiny sparkline rendered as an SVG path.
 * Values are normalized to 0–1 within the visible range.
 */
function Sparkline({
  values,
  className = "",
}: {
  values: number[];
  className?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const w = 80;
  const h = 20;
  const step = w / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${h - (v / max) * h}`);
  return (
    <svg width={w} height={h} className={className} viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function DbLoadIndicator({ enabled = true }: { enabled?: boolean }) {
  const [showPanel, setShowPanel] = useState(false);
  const [rate, setRate] = useState<RateSnapshot | null>(null);
  const [tpsHistory, setTpsHistory] = useState<number[]>([]);
  const prevRef = useRef<DbStatus | null>(null);
  const prevTimeRef = useRef<number>(0);

  const visible = usePageVisible();
  const performanceSensitive = usePerformanceSensitive();
  const active = enabled && visible && !performanceSensitive;

  const { data } = trpc.competition.dbStatus.useQuery(undefined, {
    enabled,
    refetchInterval: active ? POLL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  // When polling pauses (hidden tab or performance-sensitive page mounted),
  // the dt for the next sample after resume would span the whole pause and
  // produce an averaged-down rate. Drop the baseline so the next poll
  // establishes a fresh one.
  useEffect(() => {
    if (!active) {
      prevRef.current = null;
      prevTimeRef.current = 0;
    }
  }, [active]);

  useEffect(() => {
    if (!data) return;

    const now = Date.now();
    const prev = prevRef.current;
    const prevTime = prevTimeRef.current;
    const typed = data as DbStatus;

    if (prev && prevTime > 0) {
      const dt = (now - prevTime) / 1000;
      if (dt > 0.5) {
        const diff = (key: keyof DbStatus) =>
          Math.max(0, ((typed[key] as number) ?? 0) - ((prev[key] as number) ?? 0)) /
          dt;

        const commits = diff("xactCommit");
        const rollbacks = diff("xactRollback");
        const tps = commits + rollbacks;
        const blksRead = diff("blksRead");
        const blksHit = diff("blksHit");
        const totalBlks = blksRead + blksHit;

        const statsResetAgoMs = typed.statsReset
          ? now - new Date(typed.statsReset).getTime()
          : null;

        const snap: RateSnapshot = {
          tps,
          insertsPerSec: diff("tupInserted"),
          updatesPerSec: diff("tupUpdated"),
          deletesPerSec: diff("tupDeleted"),
          tupReturnedPerSec: diff("tupReturned"),
          blksReadPerSec: blksRead,
          cacheHitRatio: totalBlks > 0 ? blksHit / totalBlks : 1,
          rollbackRatio: tps > 0 ? rollbacks / tps : 0,
          backends: typed.backends,
          activeBackends: typed.activeBackends,
          deadlocks: typed.deadlocks,
          dbSizeBytes: typed.dbSizeBytes,
          statsResetAgoMs,
        };
        setRate(snap);
        setTpsHistory((h) => [...h.slice(-(HISTORY_LEN - 1)), snap.tps]);
      }
    }

    prevRef.current = typed;
    prevTimeRef.current = now;
  }, [data]);

  if (!rate) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-400">
        <DbIcon className="w-3.5 h-3.5" />
        <span className="tabular-nums">—</span>
      </span>
    );
  }

  const tps = rate.tps;

  return (
    <div className="relative">
      <button
        onClick={() => setShowPanel(!showPanel)}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${tpsBgColor(tps)} ${tpsColor(tps)}`}
        title={`${tps.toFixed(0)} transactions/sec — click for details`}
      >
        <DbIcon className="w-3.5 h-3.5" />
        <span className="tabular-nums">{tps.toFixed(0)}</span>
        <span className="text-[10px] opacity-60">tx/s</span>
      </button>

      {showPanel && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setShowPanel(false)}
          />
          <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-4 min-w-[280px]">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-slate-900">
                PostgreSQL status
              </h4>
              <span className="text-[10px] text-slate-400">
                stats {formatUptime(rate.statsResetAgoMs)}
              </span>
            </div>

            {/* Transaction throughput sparkline */}
            <div className="mb-3 p-2 bg-slate-50 rounded-lg">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-500">
                  Transactions / sec
                </span>
                <span
                  className={`text-sm font-bold tabular-nums ${tpsColor(tps)}`}
                >
                  {tps.toFixed(1)}
                </span>
              </div>
              <Sparkline values={tpsHistory} className={tpsColor(tps)} />
            </div>

            {/* Per-operation row rates */}
            <div className="mb-3">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">
                Rows / sec
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricRow
                  label="Returned"
                  value={rate.tupReturnedPerSec.toFixed(1)}
                />
                <MetricRow
                  label="Inserted"
                  value={rate.insertsPerSec.toFixed(1)}
                />
                <MetricRow
                  label="Updated"
                  value={rate.updatesPerSec.toFixed(1)}
                />
                <MetricRow
                  label="Deleted"
                  value={rate.deletesPerSec.toFixed(1)}
                />
              </div>
            </div>

            {/* Connections */}
            <div className="mb-3">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">
                Backends
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricRow label="Open" value={String(rate.backends)} />
                <MetricRow label="Active" value={String(rate.activeBackends)} />
              </div>
            </div>

            {/* Buffer cache */}
            <div className="mb-3">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">
                Buffer cache
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricRow
                  label="Hit ratio"
                  value={`${(rate.cacheHitRatio * 100).toFixed(1)}%`}
                  warn={rate.cacheHitRatio < 0.9}
                />
                <MetricRow
                  label="Disk reads/s"
                  value={rate.blksReadPerSec.toFixed(0)}
                />
              </div>
            </div>

            {/* Health */}
            <div>
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">
                Health
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricRow
                  label="DB size"
                  value={formatBytes(rate.dbSizeBytes)}
                />
                <MetricRow
                  label="Rollbacks"
                  value={`${(rate.rollbackRatio * 100).toFixed(1)}%`}
                  warn={rate.rollbackRatio > 0.05}
                />
                <MetricRow
                  label="Deadlocks"
                  value={String(rate.deadlocks)}
                  warn={rate.deadlocks > 0}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MetricRow({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-slate-500">{label}</span>
      <span
        className={`text-xs font-mono tabular-nums ${warn ? "text-amber-600 font-semibold" : "text-slate-700"}`}
      >
        {value}
      </span>
    </div>
  );
}

function DbIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6" />
      <path d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6" />
    </svg>
  );
}
