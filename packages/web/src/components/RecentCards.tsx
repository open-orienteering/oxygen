/**
 * Floating panel showing recent SI card reads.
 *
 * Shows a small button in the bottom-right corner with a badge
 * for the number of recent cards. Clicking expands a list.
 * Each entry navigates to the appropriate page based on the action.
 */

import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useDeviceManager, type RecentCard, type CardAction } from "../context/DeviceManager";
import { formatRunningTime } from "@oxygen/shared";

export function RecentCards() {
  const { recentCards, clearRecentCards, readerStatus, currentCard } =
    useDeviceManager();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const isConnected =
    readerStatus === "connected" || readerStatus === "reading";

  // Pulse the badge briefly when a new card arrives
  useEffect(() => {
    if (currentCard) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 1500);
      return () => clearTimeout(t);
    }
  }, [currentCard]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!isConnected && recentCards.length === 0) return null;

  const handleCardClick = (card: RecentCard) => {
    const base = location.pathname.split("/").slice(0, 2).join("/");
    switch (card.action) {
      case "readout":
        navigate(`${base}/card-readout?card=${card.cardNumber}`);
        break;
      case "register": {
        const params = new URLSearchParams({ addCard: String(card.cardNumber) });
        if (card.ownerData?.firstName) params.set("firstName", card.ownerData.firstName);
        if (card.ownerData?.lastName) params.set("lastName", card.ownerData.lastName);
        if (card.ownerData?.club) params.set("club", card.ownerData.club);
        if (card.ownerData?.sex) params.set("sex", card.ownerData.sex);
        if (card.ownerData?.dateOfBirth) params.set("dob", card.ownerData.dateOfBirth);
        if (card.ownerData?.phone) params.set("phone", card.ownerData.phone);
        navigate(`${base}/runners?${params.toString()}`);
        break;
      }
      case "pre-start":
        navigate(`${base}/start-station?card=${card.cardNumber}`);
        break;
    }
    setOpen(false);
  };

  const formatTime = (d: Date) =>
    d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="fixed bottom-6 right-6 z-50" ref={panelRef}>
      {/* Expanded panel */}
      {open && (
        <div
          className="absolute bottom-14 right-0 w-80 max-h-96 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden flex flex-col"
          data-testid="recent-cards-panel"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50">
            <span className="text-sm font-semibold text-slate-700">
              Recent Cards ({recentCards.length})
            </span>
            {recentCards.length > 0 && (
              <button
                onClick={clearRecentCards}
                className="text-xs text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="overflow-y-auto flex-1">
            {recentCards.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-400">
                No cards read yet
              </div>
            ) : (
              recentCards.map((card) => (
                <button
                  key={card.id}
                  onClick={() => handleCardClick(card)}
                  className="w-full text-left px-4 py-3 hover:bg-slate-50 border-b border-slate-50 transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ActionBadge action={card.action} />
                        <span className="font-mono text-sm font-medium text-slate-800">
                          {card.cardNumber}
                        </span>
                        {card.status && (
                          <span
                            className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                              card.status === "OK"
                                ? "bg-emerald-100 text-emerald-700"
                                : card.status === "MP"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-amber-100 text-amber-700"
                            }`}
                          >
                            {card.status}
                          </span>
                        )}
                      </div>
                      {card.runnerName ? (
                        <div className="text-xs text-slate-500 truncate">
                          {card.runnerName}
                          {card.className && ` · ${card.className}`}
                        </div>
                      ) : card.action === "register" ? (
                        <div className="text-xs text-amber-600 truncate">
                          {card.ownerData?.firstName || card.ownerData?.lastName
                            ? `${[card.ownerData.firstName, card.ownerData.lastName].filter(Boolean).join(" ")}${card.ownerData.club ? ` · ${card.ownerData.club}` : ""} — click to register`
                            : "Not registered — click to add"}
                        </div>
                      ) : (
                        <div className="text-xs text-slate-400">Unknown runner</div>
                      )}
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      {card.runningTime != null && card.runningTime > 0 && (
                        <div className="text-sm font-mono text-slate-700">
                          {formatRunningTime(card.runningTime)}
                        </div>
                      )}
                      <div className="text-xs text-slate-400">
                        {formatTime(card.timestamp)}
                      </div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Floating button */}
      <button
        onClick={() => setOpen(!open)}
        className={`relative w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all cursor-pointer ${
          isConnected
            ? "bg-emerald-600 hover:bg-emerald-700 text-white"
            : "bg-slate-600 hover:bg-slate-700 text-white"
        } ${pulse ? "scale-110" : "scale-100"}`}
        data-testid="recent-cards-button"
        title={`Recent cards (${recentCards.length})`}
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 9h3.75M15 12h3.75M15 15h3.75M4.5 19.5h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15A2.25 2.25 0 002.25 6.75v10.5A2.25 2.25 0 004.5 19.5zm6-10.125a1.875 1.875 0 11-3.75 0 1.875 1.875 0 013.75 0zm1.294 6.336a6.721 6.721 0 01-3.17.789 6.721 6.721 0 01-3.168-.789 3.376 3.376 0 016.338 0z" />
        </svg>

        {recentCards.length > 0 && (
          <span
            className={`absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center ${
              pulse ? "animate-ping-once" : ""
            }`}
          >
            {recentCards.length > 99 ? "99+" : recentCards.length}
          </span>
        )}
      </button>
    </div>
  );
}

// ─── Action Badge ───────────────────────────────────────────

function ActionBadge({ action }: { action: CardAction }) {
  switch (action) {
    case "register":
      return (
        <span className="w-5 h-5 rounded bg-amber-100 text-amber-600 flex items-center justify-center shrink-0" title="New runner">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </span>
      );
    case "pre-start":
      return (
        <span className="w-5 h-5 rounded bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0" title="Pre-start">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" />
          </svg>
        </span>
      );
    case "readout":
    default:
      return (
        <span className="w-5 h-5 rounded bg-blue-100 text-blue-600 flex items-center justify-center shrink-0" title="Readout">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </span>
      );
  }
}
