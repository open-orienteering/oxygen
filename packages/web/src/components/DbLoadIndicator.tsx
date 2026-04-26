import { useState, useEffect, useRef } from "react";
import { trpc } from "../lib/trpc";
import { usePageVisible } from "../hooks/usePageVisible";
import { usePerformanceSensitive } from "../lib/performance-mode";

const POLL_MS = 3_000;
const HISTORY_LEN = 20;

interface RateSnapshot {
  qps: number;
  selectsPerSec: number;
  insertsPerSec: number;
  updatesPerSec: number;
  deletesPerSec: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  threadsConnected: number;
  threadsRunning: number;
  slowQueries: number;
  lockWaitRatio: number;
  uptime: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function qpsColor(qps: number): string {
  if (qps < 10) return "text-emerald-600";
  if (qps < 50) return "text-blue-600";
  if (qps < 200) return "text-amber-600";
  return "text-red-600";
}

function qpsBgColor(qps: number): string {
  if (qps < 10) return "bg-emerald-50";
  if (qps < 50) return "bg-blue-50";
  if (qps < 200) return "bg-amber-50";
  return "bg-red-50";
}

/**
 * Tiny sparkline rendered as an SVG path.
 * Values are normalized to 0–1 within the visible range.
 */
function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
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
  const [qpsHistory, setQpsHistory] = useState<number[]>([]);
  const prevRef = useRef<Record<string, number> | null>(null);
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

    if (prev && prevTime > 0) {
      const dt = (now - prevTime) / 1000;
      if (dt > 0.5) {
        const diff = (key: string) => Math.max(0, (data[key] ?? 0) - (prev[key] ?? 0)) / dt;
        const locksWaited = (data.Table_locks_waited ?? 0) - (prev.Table_locks_waited ?? 0);
        const locksImmediate = (data.Table_locks_immediate ?? 0) - (prev.Table_locks_immediate ?? 0);
        const totalLocks = locksWaited + locksImmediate;

        const snap: RateSnapshot = {
          qps: diff("Questions"),
          selectsPerSec: diff("Com_select"),
          insertsPerSec: diff("Com_insert"),
          updatesPerSec: diff("Com_update"),
          deletesPerSec: diff("Com_delete"),
          bytesInPerSec: diff("Bytes_received"),
          bytesOutPerSec: diff("Bytes_sent"),
          threadsConnected: data.Threads_connected ?? 0,
          threadsRunning: data.Threads_running ?? 0,
          slowQueries: data.Slow_queries ?? 0,
          lockWaitRatio: totalLocks > 0 ? locksWaited / totalLocks : 0,
          uptime: data.Uptime ?? 0,
        };
        setRate(snap);
        setQpsHistory((h) => [...h.slice(-(HISTORY_LEN - 1)), snap.qps]);
      }
    }

    prevRef.current = { ...data };
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

  const qps = rate.qps;

  return (
    <div className="relative">
      <button
        onClick={() => setShowPanel(!showPanel)}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${qpsBgColor(qps)} ${qpsColor(qps)}`}
        title={`${qps.toFixed(0)} queries/sec — click for details`}
      >
        <DbIcon className="w-3.5 h-3.5" />
        <span className="tabular-nums">{qps.toFixed(0)}</span>
        <span className="text-[10px] opacity-60">q/s</span>
      </button>

      {showPanel && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setShowPanel(false)} />
          <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-4 min-w-[280px]">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-slate-900">MySQL Status</h4>
              <span className="text-[10px] text-slate-400">uptime {formatUptime(rate.uptime)}</span>
            </div>

            {/* QPS sparkline */}
            <div className="mb-3 p-2 bg-slate-50 rounded-lg">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-500">Queries / sec</span>
                <span className={`text-sm font-bold tabular-nums ${qpsColor(qps)}`}>
                  {qps.toFixed(1)}
                </span>
              </div>
              <Sparkline values={qpsHistory} className={qpsColor(qps)} />
            </div>

            {/* Operation breakdown */}
            <div className="mb-3">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">Operations / sec</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricRow label="SELECT" value={rate.selectsPerSec.toFixed(1)} />
                <MetricRow label="INSERT" value={rate.insertsPerSec.toFixed(1)} />
                <MetricRow label="UPDATE" value={rate.updatesPerSec.toFixed(1)} />
                <MetricRow label="DELETE" value={rate.deletesPerSec.toFixed(1)} />
              </div>
            </div>

            {/* Connections & threads */}
            <div className="mb-3">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">Connections</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricRow label="Connected" value={String(rate.threadsConnected)} />
                <MetricRow label="Running" value={String(rate.threadsRunning)} />
              </div>
            </div>

            {/* Throughput */}
            <div className="mb-3">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">Throughput</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricRow label="In" value={`${formatBytes(rate.bytesInPerSec)}/s`} />
                <MetricRow label="Out" value={`${formatBytes(rate.bytesOutPerSec)}/s`} />
              </div>
            </div>

            {/* Health */}
            <div>
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1.5">Health</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricRow label="Slow queries" value={String(rate.slowQueries)} warn={rate.slowQueries > 0} />
                <MetricRow label="Lock waits" value={`${(rate.lockWaitRatio * 100).toFixed(1)}%`} warn={rate.lockWaitRatio > 0.05} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MetricRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-xs font-mono tabular-nums ${warn ? "text-amber-600 font-semibold" : "text-slate-700"}`}>
        {value}
      </span>
    </div>
  );
}

function DbIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6" />
      <path d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6" />
    </svg>
  );
}
