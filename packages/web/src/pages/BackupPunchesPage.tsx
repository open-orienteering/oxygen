import { Fragment, useMemo, useState } from "react";
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
type Tab = "punches" | "readouts";

type ReadoutBackupRow = {
  id: string;
  stationSerial: number | null;
  slotAddress: number;
  cardNo: number;
  cardType: string;
  punches: unknown;
  punchCount: number;
  startTime: number | null;
  finishTime: number | null;
  checkTime: number | null;
  clearTime: number | null;
  originalReadAt: string | null;
  ownerData: unknown;
  importedAt: string;
  pushedAt: string | null;
  pushedReadoutId: string | null;
  matchStatus: "pushed" | "no_runner" | "pending";
  runner: {
    id: number;
    name: string;
    clubName: string;
    className: string;
  } | null;
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
  const backupReadouts = trpc.cardReadout.listReadoutBackups.useQuery();
  const pushReadoutMutation = trpc.cardReadout.pushReadoutBackup.useMutation({
    onSuccess: () => backupReadouts.refetch(),
  });

  const punches = (allPunches.data ?? []) as unknown as BackupPunch[];
  const readoutRows = (backupReadouts.data ?? []) as unknown as ReadoutBackupRow[];

  // Default to whichever tab has data. If both have data, prefer punches
  // (the legacy surface). If neither, show punches as a stub.
  const [tab, setTab] = useState<Tab>(() => {
    return "punches";
  });
  const activeTab: Tab =
    tab === "readouts" || (punches.length === 0 && readoutRows.length > 0)
      ? "readouts"
      : "punches";

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
      {/* Tab switcher — only render when there's actually card-readout data
          to switch between, to keep the page calm for the common case. */}
      {(readoutRows.length > 0 || activeTab === "readouts") && (
        <div className="flex items-center gap-1 mb-4 border-b border-slate-200">
          <TabButton
            label={`${t("backupTabPunches")} (${punches.length})`}
            active={activeTab === "punches"}
            onClick={() => setTab("punches")}
          />
          <TabButton
            label={`${t("backupTabCardReadouts")} (${readoutRows.length})`}
            active={activeTab === "readouts"}
            onClick={() => setTab("readouts")}
          />
        </div>
      )}

      {activeTab === "readouts" ? (
        <CardReadoutsTab
          rows={readoutRows}
          isLoading={backupReadouts.isLoading}
          onPush={(id) => pushReadoutMutation.mutate({ backupId: id })}
          pushPending={pushReadoutMutation.isPending}
        />
      ) : (
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
      )}
    </>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-amber-600 text-amber-700"
          : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Card-readouts tab — lists readout-station backup imports staged in
 * `card_readout_backups`. Each row is a full card readout recovered from
 * SI flash; operators review and push selected rows into card_readouts
 * via the existing live-readout pipeline.
 */
function CardReadoutsTab({
  rows,
  isLoading,
  onPush,
  pushPending,
}: {
  rows: ReadoutBackupRow[];
  isLoading: boolean;
  onPush: (backupId: string) => void;
  pushPending: boolean;
}) {
  const { t } = useTranslation("controls");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="p-8 text-center">
        <div className="inline-block w-6 h-6 border-3 border-amber-200 border-t-amber-600 rounded-full animate-spin" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400 text-sm">
        {t("noBackupReadoutsImported")}
      </div>
    );
  }

  const colCount = 7;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs border-b border-slate-100">
              <th className="px-4 py-2 text-left font-medium text-slate-500">{t("card")}</th>
              <th className="px-4 py-2 text-left font-medium text-slate-500">{t("cardType")}</th>
              <th className="px-4 py-2 text-left font-medium text-slate-500">{t("runner")}</th>
              <th className="px-4 py-2 text-left font-medium text-slate-500">{t("punches")}</th>
              <th className="px-4 py-2 text-left font-medium text-slate-500">{t("startFinish")}</th>
              <th className="px-4 py-2 text-left font-medium text-slate-500">{t("importedAt")}</th>
              <th className="px-4 py-2 text-right font-medium text-slate-500">{t("matchStatus")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map((r) => {
              const isExpanded = expandedId === r.id;
              return (
                <Fragment key={r.id}>
                  <tr
                    onClick={() => setExpandedId(isExpanded ? null : r.id)}
                    className={`cursor-pointer hover:bg-slate-50 transition-colors ${
                      isExpanded ? "bg-blue-50" : r.matchStatus === "pending" ? "bg-amber-50/50" : ""
                    }`}
                  >
                    <td className="px-4 py-2 font-mono tabular-nums">{r.cardNo}</td>
                    <td className="px-4 py-2 text-slate-600">{r.cardType || "—"}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {r.runner ? (
                        <>
                          <span>{r.runner.name}</span>
                          {r.runner.clubName && (
                            <span className="ml-2 text-xs text-slate-400">{r.runner.clubName}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono tabular-nums">{r.punchCount}</td>
                    <td className="px-4 py-2 font-mono tabular-nums text-slate-500">
                      {formatDs(r.startTime ?? 0)}
                      <span className="mx-1 text-slate-300">/</span>
                      {formatDs(r.finishTime ?? 0)}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {new Date(r.importedAt).toLocaleString(undefined, { hour12: false })}
                    </td>
                    <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <ReadoutMatchBadge status={r.matchStatus} />
                      {r.matchStatus === "pending" && (
                        <button
                          onClick={() => onPush(r.id)}
                          disabled={pushPending}
                          className="ml-2 text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                        >
                          {t("pushToReadout")}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${r.id}-detail`}>
                      <td colSpan={colCount} className="p-0">
                        <ReadoutBackupDetail row={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type RawPunch = { controlCode: number; time: number; subSecond?: number | null };

function ReadoutBackupDetail({ row }: { row: ReadoutBackupRow }) {
  const { t } = useTranslation("controls");
  const punches = Array.isArray(row.punches) ? (row.punches as RawPunch[]) : [];
  // Show punches in chronological order, with running cumulative time
  // relative to start (if start is known) so splits read like a receipt.
  const sorted = [...punches].sort((a, b) => a.time - b.time);
  const startDs = row.startTime ?? null;
  const owner = row.ownerData as { firstName?: string; lastName?: string; club?: string; email?: string } | null;

  return (
    <div className="bg-blue-50/60 border-t border-blue-100 p-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Card header */}
        <div className="space-y-2 text-sm">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {t("card")} {row.cardNo} ({row.cardType || "?"})
          </h4>
          <dl className="space-y-1">
            <Row label={t("clear")} value={row.clearTime != null ? formatDs(row.clearTime) : null} />
            <Row label={t("check")} value={row.checkTime != null ? formatDs(row.checkTime) : null} />
            <Row label={t("start")} value={row.startTime != null ? formatDs(row.startTime) : null} />
            <Row label={t("finish")} value={row.finishTime != null ? formatDs(row.finishTime) : null} />
            <Row label={t("stationSerial")} value={row.stationSerial != null ? String(row.stationSerial) : null} />
            <Row
              label={t("originalReadAt")}
              value={row.originalReadAt ? new Date(row.originalReadAt).toLocaleString() : null}
            />
          </dl>
        </div>

        {/* Owner (SIAC/SI10/SI11 cards) */}
        {owner && (owner.firstName || owner.lastName || owner.club) && (
          <div className="space-y-2 text-sm">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("owner")}</h4>
            <dl className="space-y-1">
              <Row label={t("runner")} value={[owner.firstName, owner.lastName].filter(Boolean).join(" ") || null} />
              <Row label={t("clubName", { defaultValue: "Club" })} value={owner.club ?? null} />
              <Row label="Email" value={owner.email ?? null} />
            </dl>
          </div>
        )}

        {/* Punches */}
        <div className="space-y-2 text-sm lg:col-span-1">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {t("punches")} ({sorted.length})
          </h4>
          <div className="bg-white rounded-lg border border-slate-200 max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0">
                <tr className="text-slate-500">
                  <th className="px-3 py-1.5 text-left font-medium">#</th>
                  <th className="px-3 py-1.5 text-left font-medium">{t("control")}</th>
                  <th className="px-3 py-1.5 text-right font-medium">{t("backupTime")}</th>
                  <th className="px-3 py-1.5 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sorted.map((p, i) => {
                  const split = startDs != null ? p.time - startDs : null;
                  return (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-1.5 text-slate-400 font-mono tabular-nums">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono font-medium text-amber-700">{p.controlCode}</td>
                      <td className="px-3 py-1.5 font-mono tabular-nums text-right">{formatDs(p.time)}</td>
                      <td className="px-3 py-1.5 font-mono tabular-nums text-right text-slate-500">
                        {split != null && split > 0 ? formatDs(split) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500 w-28 text-xs">{label}:</dt>
      <dd className="font-mono text-slate-700 text-xs">
        {value ?? <span className="text-slate-300">—</span>}
      </dd>
    </div>
  );
}

function ReadoutMatchBadge({
  status,
}: { status: "pushed" | "no_runner" | "pending" }) {
  const { t } = useTranslation("controls");
  switch (status) {
    case "pushed":
      return (
        <span className="text-xs font-medium text-green-700 bg-green-100 px-1.5 py-0.5 rounded">
          {t("statusPushed")}
        </span>
      );
    case "no_runner":
      return (
        <span className="text-xs font-medium text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
          {t("statusNoRunner")}
        </span>
      );
    case "pending":
      return (
        <span className="text-xs font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
          {t("statusPending")}
        </span>
      );
  }
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
