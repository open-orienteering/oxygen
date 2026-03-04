import { useState, useCallback, useRef, useMemo } from "react";
import { trpc } from "../lib/trpc";
import { useSearchParam, useNumericSearchParam } from "../hooks/useSearchParam";
import { formatDateTime, timeAgo } from "../lib/format";
import { ClubLogo } from "../components/ClubLogo";
import { SortHeader } from "../components/SortHeader";
import { useSort } from "../hooks/useSort";

export function ClubsPage() {
  const [search, setSearch] = useSearchParam("search");
  const [showAllParam, setShowAllParam] = useSearchParam("all");
  const [expandedId, setExpandedId] = useNumericSearchParam("club");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const showAll = showAllParam === "1";

  const utils = trpc.useUtils();
  const syncStatus = trpc.eventor.syncStatus.useQuery();

  const clubs = trpc.club.list.useQuery({
    search: search || undefined,
    showAll,
  });

  const deleteMutation = trpc.club.delete.useMutation({
    onSuccess: () => {
      utils.club.list.invalidate();
      utils.club.detail.invalidate();
    },
  });

  const clubSyncMutation = trpc.eventor.syncClubs.useMutation({
    onSuccess: () => {
      utils.club.list.invalidate();
      utils.club.detail.invalidate();
    },
  });

  const handleDelete = (id: number, name: string) => {
    if (window.confirm(`Remove club "${name}"?`)) {
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

  const { sorted: items, sort, toggle } = useSort(clubs.data ?? [], { key: "name", dir: "asc" }, comparators);

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
            placeholder="Search club name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          />
        </div>
        <button
          onClick={() => setShowAllParam(showAll ? "" : "1")}
          className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors cursor-pointer ${showAll
            ? "bg-blue-50 border-blue-300 text-blue-700"
            : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
        >
          {showAll ? "Showing all clubs" : "Show all clubs"}
        </button>
        {syncStatus.data?.apiKeyConfigured && (
          <button
            onClick={() => clubSyncMutation.mutate()}
            disabled={clubSyncMutation.isPending}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-1.5"
            title="Sync full club directory from Eventor"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {clubSyncMutation.isPending ? "Syncing..." : "Sync from Eventor"}
          </button>
        )}
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Club
        </button>
      </div>

      {/* Club sync results */}
      {clubSyncMutation.isSuccess && clubSyncMutation.data && (
        <div className="mb-4 p-3 bg-green-50 rounded-lg border border-green-200 text-sm text-green-800 flex items-center justify-between">
          <span>
            <span className="font-medium">Club sync complete:</span>{" "}
            {clubSyncMutation.data.added} added, {clubSyncMutation.data.updated} updated
            {" "}({clubSyncMutation.data.total} total in Eventor)
          </span>
          <button
            onClick={() => clubSyncMutation.reset()}
            className="text-green-600 hover:text-green-800 cursor-pointer text-xs"
          >
            Dismiss
          </button>
        </div>
      )}
      {clubSyncMutation.isError && (
        <div className="mb-4 p-3 bg-red-50 rounded-lg border border-red-200 text-sm text-red-700">
          Club sync failed: {clubSyncMutation.error.message}
        </div>
      )}

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
        {items.length} clubs{!showAll && " with runners"}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wider">
              <SortHeader label="#" active={sort.key === "id"} direction={sort.dir} onClick={() => toggle("id")} />
              <SortHeader label="Name" active={sort.key === "name"} direction={sort.dir} onClick={() => toggle("name")} />
              <SortHeader label="Short Name" active={sort.key === "shortName"} direction={sort.dir} onClick={() => toggle("shortName")} />
              <SortHeader label="Runners" active={sort.key === "runners"} direction={sort.dir} onClick={() => toggle("runners")} align="right" />
              <th className="px-4 py-3 w-10 font-medium text-slate-500">Actions</th>
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
                  {clubs.isLoading ? "Loading..." : "No clubs found"}
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
            title="Remove club"
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
    return <div className="text-sm text-slate-400">Loading...</div>;
  }
  if (!detail.data) {
    return <div className="text-sm text-red-500">Club not found</div>;
  }

  const d = detail.data;

  return (
    <div className="space-y-4">
      {/* Editable fields */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
          <input
            type="text"
            defaultValue={d.name}
            onChange={(e) => debouncedUpdate({ id: clubId, name: e.target.value })}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Short Name</label>
          <input
            type="text"
            defaultValue={d.shortName}
            maxLength={17}
            onChange={(e) => debouncedUpdate({ id: clubId, shortName: e.target.value })}
            className="w-full px-3 py-1.5 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Country</label>
          <div className="text-sm text-slate-700 py-1.5">{d.country || d.nationality || "—"}</div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Logo</label>
          <div className="flex items-center gap-2 py-1.5">
            <ClubLogo clubId={d.id} size="lg" />
          </div>
        </div>
        {d.extId > 0 && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Eventor ID</label>
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
            Contact &amp; Address
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {d.careOf && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">c/o</label>
                <div className="text-sm text-slate-700">{d.careOf}</div>
              </div>
            )}
            {d.street && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Street</label>
                <div className="text-sm text-slate-700">{d.street}</div>
              </div>
            )}
            {(d.zip || d.city) && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">City</label>
                <div className="text-sm text-slate-700">{[d.zip, d.city].filter(Boolean).join(" ")}</div>
              </div>
            )}
            {d.email && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Email</label>
                <div className="text-sm text-slate-700 truncate">{d.email}</div>
              </div>
            )}
            {d.phone && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Phone</label>
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
            Runners ({d.runners.length})
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
        <div className="text-xs text-slate-400">No runners in this club</div>
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
      <h3 className="text-sm font-semibold text-slate-900 mb-3">New Club</h3>
      <form onSubmit={handleSubmit} className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500 mb-1">Club Name</label>
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
          <label className="block text-xs font-medium text-slate-500 mb-1">Short Name</label>
          <input
            type="text"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            placeholder="Auto"
            maxLength={17}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <button
          type="submit"
          disabled={createMutation.isPending || !name.trim()}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
        >
          {createMutation.isPending ? "Adding..." : "Add"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-slate-500 text-sm hover:text-slate-700 cursor-pointer"
        >
          Cancel
        </button>
      </form>
      {createMutation.isError && (
        <div className="mt-2 text-sm text-red-600">{createMutation.error.message}</div>
      )}
    </div>
  );
}
