import { useState, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { type ClubSummary } from "@oxygen/shared";
import { useSearchParam, useNumericSearchParam } from "../hooks/useSearchParam";
import { formatDateTime } from "../lib/format";
import { ClubLogo } from "../components/ClubLogo";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import { createClubAnchors } from "../lib/structured-search/anchors/club-anchors";

export function ClubsPage() {
  const { t } = useTranslation("clubs");
  const [showAllParam, setShowAllParam] = useSearchParam("all");
  const [expandedId, setExpandedId] = useNumericSearchParam("club");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const showAll = showAllParam === "1";

  const utils = trpc.useUtils();

  const anchors = useMemo(() => createClubAnchors((key) => t(key as never)), [t]);
  const { tokens, setTokens, filterItems } = useStructuredSearch<ClubSummary>(
    anchors,
    ["name", "shortName"],
  );

  const clubs = trpc.club.list.useQuery({ showAll });

  const deleteMutation = trpc.club.delete.useMutation({
    onSuccess: () => {
      utils.club.list.invalidate();
      utils.club.detail.invalidate();
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

  type Club = NonNullable<typeof clubs.data>[number];
  const comparators = useMemo(() => ({
    id: (a: Club, b: Club) => a.id - b.id,
    name: (a: Club, b: Club) => a.name.localeCompare(b.name),
    shortName: (a: Club, b: Club) => a.shortName.localeCompare(b.shortName),
    runners: (a: Club, b: Club) => a.runnerCount - b.runnerCount,
  }), []);

  const filtered = useMemo(() => filterItems(clubs.data ?? []), [clubs.data, filterItems]);
  const { sorted: items, sort, toggle } = useSort(filtered, { key: "name", dir: "asc" }, comparators);

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={anchors}
          placeholder={t("searchPlaceholder")}
        />
        <button
          onClick={() => setShowAllParam(showAll ? "" : "1")}
          className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${showAll
            ? "bg-blue-50 border-blue-300 text-blue-700"
            : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
        >
          {showAll ? t("showingAll") : t("showAll")}
        </button>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer flex items-center gap-1 whitespace-nowrap"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t("newClub")}
        </button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <CreateClubForm
          onCreated={() => {
            setShowCreateForm(false);
            utils.club.list.invalidate();
          }}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Club count */}
      <div className="text-sm text-slate-500 mb-3">
        {!showAll ? t("clubsWithRunners", { count: items.length }) : t("clubsAll", { count: items.length })}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wider">
              <SortHeader label="#" active={sort.key === "id"} direction={sort.dir} onClick={() => toggle("id")} />
              <SortHeader label={t("name")} active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
              <SortHeader label={t("shortName")} active={sort.key === "shortName"} direction={sort.dir} onClick={() => toggle("shortName")} />
              <SortHeader label={t("runners")} active={sort.key === "runners"} direction={sort.dir} onClick={() => toggle("runners")} align="right" />
              <th className="px-4 py-3 w-10 font-medium text-slate-500">{t("actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((club) => (
              <ClubRow
                key={club.id}
                club={club}
                isExpanded={expandedId === club.id}
                onToggle={() => handleToggleExpand(club.id)}
                onDelete={() => handleDelete(club.id, club.name)}
              />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  {clubs.isLoading ? t("loading") : t("noClubs")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Club Row ───────────────────────────────────────────────

function ClubRow({
  club,
  isExpanded,
  onToggle,
  onDelete,
}: {
  club: { id: number; name: string; shortName: string; runnerCount: number; extId: number };
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("clubs");

  return (
    <>
      <tr
        onClick={onToggle}
        className="hover:bg-blue-50 transition-colors cursor-pointer group"
      >
        <td className="px-4 py-3 text-slate-400">{club.id}</td>
        <td className="px-4 py-3">
          <span className="inline-flex items-center gap-1.5">
            <ClubLogo clubId={club.id} size="sm" />
            <span className="font-medium text-blue-700 group-hover:text-blue-900">
              {club.name}
            </span>
          </span>
          {club.extId > 0 && (
            <span className="ml-2 text-[10px] text-slate-400 font-mono">
              E:{club.extId}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-slate-500">{club.shortName}</td>
        <td className="px-4 py-3 text-right text-slate-600">{club.runnerCount}</td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 text-slate-300 hover:text-red-500 transition-colors cursor-pointer"
            title={t("removeClub")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={5} className="bg-slate-50 px-6 py-4 border-t border-slate-100">
            <ClubDetailPanel clubId={club.id} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Club Detail Panel ──────────────────────────────────────

function ClubDetailPanel({ clubId }: { clubId: number }) {
  const { t } = useTranslation("clubs");
  const detail = trpc.club.detail.useQuery({ id: clubId });
  const utils = trpc.useUtils();

  const updateMutation = trpc.club.update.useMutation({
    onSuccess: () => {
      utils.club.list.invalidate();
      utils.club.detail.invalidate({ id: clubId });
    },
  });

  const timerRef = useRef<any>(undefined);
  const debouncedUpdate = useCallback(
    (data: { id: number; name?: string; shortName?: string }) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => updateMutation.mutate(data), 500);
    },
    [clubId],
  );

  if (detail.isLoading) {
    return <div className="text-sm text-slate-400">{t("loading")}</div>;
  }
  if (!detail.data) {
    return <div className="text-sm text-red-500">{t("clubNotFound")}</div>;
  }

  const d = detail.data;

  return (
    <div className="space-y-4">
      {/* Editable fields */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("name")}</label>
          <input
            type="text"
            defaultValue={d.name}
            onChange={(e) => debouncedUpdate({ id: clubId, name: e.target.value })}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("shortName")}</label>
          <input
            type="text"
            defaultValue={d.shortName}
            maxLength={17}
            onChange={(e) => debouncedUpdate({ id: clubId, shortName: e.target.value })}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("country")}</label>
          <div className="text-sm text-slate-700 py-1.5">{d.country || d.nationality || "—"}</div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("logo")}</label>
          <div className="flex items-center gap-2 py-1.5">
            <ClubLogo clubId={d.id} size="lg" />
          </div>
        </div>
        {d.extId > 0 && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("eventorId")}</label>
            <div className="flex items-center gap-2 py-1.5">
              <span className="text-sm text-slate-700 font-mono">{d.extId}</span>
            </div>
          </div>
        )}
      </div>

      {/* Address */}
      {(d.street || d.city || d.zip || d.careOf || d.email || d.phone) && (
        <div>
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
            {t("contactAddress")}
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {d.careOf && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">{t("careOf")}</label>
                <div className="text-sm text-slate-700">{d.careOf}</div>
              </div>
            )}
            {d.street && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">{t("street")}</label>
                <div className="text-sm text-slate-700">{d.street}</div>
              </div>
            )}
            {(d.zip || d.city) && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">{t("city")}</label>
                <div className="text-sm text-slate-700">{[d.zip, d.city].filter(Boolean).join(" ")}</div>
              </div>
            )}
            {d.email && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">{t("email")}</label>
                <div className="text-sm text-slate-700 truncate">{d.email}</div>
              </div>
            )}
            {d.phone && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">{t("phone")}</label>
                <div className="text-sm text-slate-700">{d.phone}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Runners in this club */}
      {d.runners.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
            {t("runnersCount", { count: d.runners.length })}
          </h4>
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100 max-h-48 overflow-y-auto">
            {d.runners.map((r) => (
              <div key={r.id} className="px-3 py-2 flex items-center justify-between text-sm">
                <span className="text-slate-800">{r.name}</span>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  {r.className && <span>{r.className}</span>}
                  {r.cardNo > 0 && <span className="font-mono">{r.cardNo}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {d.runners.length === 0 && (
        <div className="text-xs text-slate-400">{t("noRunners")}</div>
      )}
    </div>
  );
}

// ─── Create Club Form ───────────────────────────────────────

function CreateClubForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("clubs");
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");

  const createMutation = trpc.club.create.useMutation({
    onSuccess: () => onCreated(),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      shortName: shortName.trim() || undefined,
    });
  };

  return (
    <div className="mb-4 bg-blue-50 rounded-xl border border-blue-200 p-4">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">{t("newClub")}</h3>
      <form onSubmit={handleSubmit} className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("clubName")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. OK Ansen"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            autoFocus
            required
          />
        </div>
        <div className="w-40">
          <label className="block text-xs font-medium text-slate-500 mb-1">{t("shortName")}</label>
          <input
            type="text"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            placeholder={t("shortNamePlaceholder")}
            maxLength={17}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <button
          type="submit"
          disabled={createMutation.isPending || !name.trim()}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
        >
          {createMutation.isPending ? t("adding") : t("add")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-slate-500 text-sm hover:text-slate-700 cursor-pointer"
        >
          {t("cancel")}
        </button>
      </form>
      {createMutation.isError && (
        <div className="mt-2 text-sm text-red-600">{createMutation.error.message}</div>
      )}
    </div>
  );
}
