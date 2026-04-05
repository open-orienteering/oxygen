/**
 * Sidebar listing all participants with show/hide toggles, club filter,
 * result info, and color swatches.
 */

import { useState, useMemo } from "react";
import type { ReplayRoute } from "@oxygen/shared";

interface Props {
  routes: ReplayRoute[];
  visibleParticipants: Set<string>;
  toggleParticipant: (id: string) => void;
  showAll: () => void;
  hideAll: () => void;
  showOnly: (ids: string[]) => void;
}

function formatResultTime(ms: number | undefined): string {
  if (ms === undefined) return "";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ParticipantList({
  routes,
  visibleParticipants,
  toggleParticipant,
  showAll,
  hideAll,
  showOnly,
}: Props) {
  const [search, setSearch] = useState("");
  const [clubFilter, setClubFilter] = useState("");

  // Distinct clubs sorted by name
  const clubs = useMemo(() => {
    const set = new Set<string>();
    for (const r of routes) {
      if (r.organisation) set.add(r.organisation);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [routes]);

  const sorted = useMemo(() => {
    let filtered = routes;
    if (clubFilter) {
      filtered = filtered.filter((r) => r.organisation === clubFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.organisation?.toLowerCase().includes(q),
      );
    }
    return [...filtered].sort((a, b) => {
      const ra = a.result?.rank ?? 999;
      const rb = b.result?.rank ?? 999;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }, [routes, search, clubFilter]);

  // Select club: show only that club's runners
  const selectClub = (club: string) => {
    if (club === clubFilter) {
      setClubFilter("");
      showAll();
    } else {
      setClubFilter(club);
      const clubIds = routes
        .filter((r) => r.organisation === club)
        .map((r) => r.participantId);
      showOnly(clubIds);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white text-slate-900 text-sm">
      {/* Header */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-slate-200 space-y-1.5">
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-white text-slate-900 text-xs px-2 py-1 rounded border border-slate-200 focus:border-blue-500 focus:outline-none"
        />
        <select
          value={clubFilter}
          onChange={(e) => selectClub(e.target.value)}
          className="w-full bg-white text-slate-900 text-xs px-2 py-1 rounded border border-slate-200 focus:border-blue-500 focus:outline-none"
        >
          <option value="">All clubs ({clubs.length})</option>
          {clubs.map((c) => (
            <option key={c} value={c}>
              {c} ({routes.filter((r) => r.organisation === c).length})
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <button
            onClick={showAll}
            className="text-xs text-slate-500 hover:text-slate-900 transition-colors px-1.5 py-0.5 rounded border border-slate-300 cursor-pointer"
          >
            All
          </button>
          <button
            onClick={hideAll}
            className="text-xs text-slate-500 hover:text-slate-900 transition-colors px-1.5 py-0.5 rounded border border-slate-300 cursor-pointer"
          >
            None
          </button>
          <span className="text-xs text-slate-500 ml-auto">
            {visibleParticipants.size}/{routes.length}
          </span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sorted.map((route) => {
          const visible = visibleParticipants.has(route.participantId);
          return (
            <button
              key={route.participantId}
              onClick={() => toggleParticipant(route.participantId)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-100 transition-colors cursor-pointer ${
                visible ? "" : "opacity-40"
              }`}
            >
              <span
                className="w-3 h-3 rounded-sm flex-shrink-0 border"
                style={{
                  backgroundColor: visible ? route.color : "transparent",
                  borderColor: route.color ?? "#666",
                }}
              />
              <span className="flex-1 min-w-0 truncate text-xs">
                {route.name}
                {route.organisation && !clubFilter && (
                  <span className="text-slate-500 ml-1">
                    {route.organisation}
                  </span>
                )}
              </span>
              {route.result && (
                <span className="text-xs tabular-nums text-slate-400 flex-shrink-0">
                  {route.result.rank != null && (
                    <span className="mr-1">#{route.result.rank}</span>
                  )}
                  {formatResultTime(route.result.timeMs)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
