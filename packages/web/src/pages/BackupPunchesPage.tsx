import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";
import { useSort } from "../hooks/useSort";
import { SortHeader } from "../components/SortHeader";

type BackupPunch = {
  id: number;
  controlId: number;
  controlCodes: string;
  controlName: string;
  cardNo: number;
  punchTime: number;
  punchDatetime: string | null;
  subSecond: number | null;
  importedAt: string;
  pushedToPunch: boolean;
  runnerName: string | null;
  runnerId: number | null;
};

function fmtIso(d: Date): string {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

function formatPunchDatetime(p: BackupPunch): string {
  if (p.punchDatetime) {
    const d = new Date(p.punchDatetime);
    const ms = p.subSecond != null ? `.${Math.round((p.subSecond / 256) * 10)}` : "";
    return `${fmtIso(d)}${ms}`;
  }
  // Fallback: deciseconds since midnight
  const totalSecs = Math.floor(p.punchTime / 10);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const comparators: Record<string, (a: BackupPunch, b: BackupPunch) => number> = {
  control: (a, b) => a.controlCodes.localeCompare(b.controlCodes, undefined, { numeric: true }),
  card: (a, b) => a.cardNo - b.cardNo,
  time: (a, b) => (a.punchDatetime ?? "").localeCompare(b.punchDatetime ?? "") || a.punchTime - b.punchTime,
  runner: (a, b) => (a.runnerName ?? "").localeCompare(b.runnerName ?? ""),
  imported: (a, b) => a.importedAt.localeCompare(b.importedAt),
  status: (a, b) => Number(a.pushedToPunch) - Number(b.pushedToPunch),
};

export function BackupPunchesPage() {
  const [filter, setFilter] = useState<"all" | "new" | "pushed">("all");

  const allPunches = trpc.control.listAllBackupPunches.useQuery();
  const pushMutation = trpc.control.pushBackupPunch.useMutation({
    onSuccess: () => allPunches.refetch(),
  });

  const punches = (allPunches.data ?? []) as BackupPunch[];
  const filtered = useMemo(() =>
    filter === "all"
      ? punches
      : filter === "pushed"
        ? punches.filter((p) => p.pushedToPunch)
        : punches.filter((p) => !p.pushedToPunch),
    [punches, filter],
  );

  const { sorted, sort, toggle } = useSort(filtered, { key: "time", dir: "asc" }, comparators);

  const totalPunches = punches.length;
  const pushedCount = punches.filter((p) => p.pushedToPunch).length;
  const newCount = totalPunches - pushedCount;

  const controlCount = useMemo(() => new Set(filtered.map((p) => p.controlId)).size, [filtered]);

  return (
    <>
      {/* Summary + filter */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-medium text-slate-500">
            {totalPunches} backup punches from {controlCount} controls
          </h2>
          {newCount > 0 && (
            <span className="text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
              {newCount} not pushed
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(["all", "new", "pushed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer ${
                filter === f
                  ? "bg-amber-600 text-white"
                  : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f === "all" ? "All" : f === "new" ? "Not pushed" : "Pushed"}
            </button>
          ))}
        </div>
      </div>

      {allPunches.isLoading && (
        <div className="p-8 text-center">
          <div className="inline-block w-6 h-6 border-3 border-amber-200 border-t-amber-600 rounded-full animate-spin" />
        </div>
      )}

      {!allPunches.isLoading && totalPunches === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400 text-sm">
          No backup punches imported yet. Use the "Read Controls" panel on the Controls page to read backup memory from field controls.
        </div>
      )}

      {sorted.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs border-b border-slate-100">
                  <SortHeader label="Control" active={sort.key === "control"} direction={sort.dir} onClick={() => toggle("control")} />
                  <SortHeader label="Card" active={sort.key === "card"} direction={sort.dir} onClick={() => toggle("card")} />
                  <SortHeader label="Time" active={sort.key === "time"} direction={sort.dir} onClick={() => toggle("time")} />
                  <SortHeader label="Runner" active={sort.key === "runner"} direction={sort.dir} onClick={() => toggle("runner")} />
                  <SortHeader label="Imported" active={sort.key === "imported"} direction={sort.dir} onClick={() => toggle("imported")} />
                  <SortHeader label="Status" active={sort.key === "status"} direction={sort.dir} onClick={() => toggle("status")} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {sorted.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <span className="font-mono font-bold text-amber-700">{p.controlCodes}</span>
                      {p.controlName && (
                        <span className="ml-2 text-slate-500">{p.controlName}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono tabular-nums">{p.cardNo}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">
                      {formatPunchDatetime(p)}
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {p.runnerName ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">
                      {p.importedAt}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {p.pushedToPunch ? (
                        <span className="text-xs text-green-600 font-medium">Pushed</span>
                      ) : (
                        <button
                          onClick={() => pushMutation.mutate({ punchId: p.id })}
                          disabled={pushMutation.isPending}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                        >
                          Push to oPunch
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
