import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { useSort } from "../hooks/useSort";
import { SortHeader } from "../components/SortHeader";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import {
  createBackupPunchAnchors,
  type BackupPunchRow,
  type MatchStatus,
} from "../lib/structured-search/anchors/backup-punch-anchors";

type BackupPunch = BackupPunchRow;

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
  const totalSecs = Math.floor(p.punchTime / 10);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDs(ds: number): string {
  const totalSecs = Math.floor(ds / 10);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const matchStatusOrder: Record<MatchStatus, number> = {
  no_runner: 0,
  time_mismatch: 1,
  no_result: 2,
  unknown: 3,
  matched: 4,
};

const comparators: Record<string, (a: BackupPunch, b: BackupPunch) => number> = {
  control: (a, b) => a.controlCodes.localeCompare(b.controlCodes, undefined, { numeric: true }),
  card: (a, b) => a.cardNo - b.cardNo,
  time: (a, b) => (a.punchDatetime ?? "").localeCompare(b.punchDatetime ?? "") || a.punchTime - b.punchTime,
  runner: (a, b) => (a.runnerName ?? "").localeCompare(b.runnerName ?? ""),
  match: (a, b) => matchStatusOrder[a.matchStatus] - matchStatusOrder[b.matchStatus],
};

export function BackupPunchesPage() {
  const { t } = useTranslation("controls");

  const allPunches = trpc.control.listAllBackupPunches.useQuery();
  const pushMutation = trpc.control.pushBackupPunch.useMutation({
    onSuccess: () => allPunches.refetch(),
  });

  const punches = (allPunches.data ?? []) as BackupPunch[];

  const anchors = useMemo(
    () => createBackupPunchAnchors((key) => t(key as never)),
    [t],
  );
  const { tokens, setTokens, filterItems } = useStructuredSearch<BackupPunchRow>(
    anchors,
    ["runnerName", "controlCodes", "controlName"],
  );

  const suggestionData = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of punches) {
      if (!map.has(p.controlId)) {
        map.set(p.controlId, p.controlCodes || String(p.controlId));
      }
    }
    return {
      controls: Array.from(map.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([id, code]) => ({ id, code })),
    };
  }, [punches]);

  const filtered = useMemo(() => filterItems(punches), [punches, filterItems]);
  const { sorted, sort, toggle } = useSort(filtered, { key: "time", dir: "asc" }, comparators);

  return (
    <>
      {/* Search row */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={anchors}
          placeholder={t("searchCard")}
          suggestionData={suggestionData}
        />
        <span className="text-xs text-slate-400 whitespace-nowrap">
          {t("showingCount", { shown: sorted.length, total: punches.length })}
        </span>
      </div>

      {allPunches.isLoading && (
        <div className="p-8 text-center">
          <div className="inline-block w-6 h-6 border-3 border-amber-200 border-t-amber-600 rounded-full animate-spin" />
        </div>
      )}

      {!allPunches.isLoading && punches.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400 text-sm">
          {t("noBackupPunchesImported")}
        </div>
      )}

      {sorted.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs border-b border-slate-100">
                  <SortHeader label={t("control")} active={sort.key === "control"} direction={sort.dir} onClick={() => toggle("control")} />
                  <SortHeader label={t("card")} active={sort.key === "card"} direction={sort.dir} onClick={() => toggle("card")} />
                  <SortHeader label={t("backupTime")} active={sort.key === "time"} direction={sort.dir} onClick={() => toggle("time")} />
                  <SortHeader label={t("runner")} active={sort.key === "runner"} direction={sort.dir} onClick={() => toggle("runner")} />
                  <th className="px-4 py-2 text-left font-medium text-slate-500">{t("registeredTime")}</th>
                  <SortHeader label={t("matchStatus")} active={sort.key === "match"} direction={sort.dir} onClick={() => toggle("match")} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {sorted.map((p) => (
                  <tr key={p.id} className={`hover:bg-slate-50 ${p.matchStatus !== "matched" && p.matchStatus !== "unknown" ? "bg-amber-50/50" : ""}`}>
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
                    <td className="px-4 py-2 font-mono tabular-nums text-slate-500">
                      {p.registeredTime != null && p.registeredTime > 0
                        ? formatDs(p.registeredTime)
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <MatchBadge status={p.matchStatus} />
                      {!p.pushedToPunch && p.matchStatus !== "matched" && (
                        <button
                          onClick={() => pushMutation.mutate({ punchId: p.id })}
                          disabled={pushMutation.isPending}
                          className="ml-2 text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                        >
                          {t("pushToOPunch")}
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

function MatchBadge({ status }: { status: MatchStatus }) {
  const { t } = useTranslation("controls");
  switch (status) {
    case "matched":
      return <span className="text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded">{t("statusMatched")}</span>;
    case "no_runner":
      return <span className="text-xs font-medium text-red-700 bg-red-100 px-1.5 py-0.5 rounded">{t("statusNoRunner")}</span>;
    case "no_result":
      return <span className="text-xs font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">{t("statusNoResult")}</span>;
    case "time_mismatch":
      return <span className="text-xs font-medium text-red-700 bg-red-100 px-1.5 py-0.5 rounded">{t("statusTimeMismatch")}</span>;
    case "unknown":
      return <span className="text-xs font-medium text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">—</span>;
  }
}
