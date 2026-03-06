/**
 * Kiosk Mode — user-facing fullscreen display.
 *
 * States: idle → readout | pre-start | registration
 *
 * In paired mode, receives card events via BroadcastChannel from admin.
 * In standalone mode, uses its own DeviceManager + SI reader.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { trpc } from "../lib/trpc";
import { formatMeosTime, formatRunningTime, RunnerStatus } from "@oxygen/shared";
import {
  KioskChannel,
  type KioskMessage,
  type KioskCardReadoutMessage,
  type RegistrationFormState,
} from "../lib/kiosk-channel";
import swishIcon from "../assets/swish-icon.svg";
import { ClubLogo } from "../components/ClubLogo";
import { useDeviceManager } from "../context/DeviceManager";
import { recentCardToKioskMessage } from "../lib/kiosk-channel";

// ─── Types ──────────────────────────────────────────────────

type KioskScreen =
  | { mode: "idle" }
  | { mode: "reading"; cardNumber: number }
  | { mode: "card-done"; cardNumber: number; next: KioskScreen }
  | { mode: "readout"; card: KioskCardReadoutMessage["card"] }
  | { mode: "pre-start"; card: KioskCardReadoutMessage["card"] }
  | { mode: "registration-waiting"; card: KioskCardReadoutMessage["card"]; form?: RegistrationFormState }
  | { mode: "registration-complete"; runner: { name: string; className: string; clubName: string; startTime: string; cardNo: number; clubEventorId?: number } };

interface KioskSettings {
  standalone: boolean;
  requireClearCheck: boolean;
  autoResetSeconds: number;
  writeToCard: boolean;
}

const DEFAULT_SETTINGS: KioskSettings = {
  standalone: false,
  requireClearCheck: false,
  autoResetSeconds: 15,
  writeToCard: false,
};

function loadSettings(nameId: string): KioskSettings {
  try {
    const raw = localStorage.getItem(`oxygen-kiosk-settings-${nameId}`);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS;
}

function saveSettings(nameId: string, settings: KioskSettings): void {
  localStorage.setItem(`oxygen-kiosk-settings-${nameId}`, JSON.stringify(settings));
}

// ─── Main Kiosk Page ────────────────────────────────────────

export function KioskPage() {
  const { nameId } = useParams<{ nameId: string }>();
  const [screen, setScreen] = useState<KioskScreen>({ mode: "idle" });
  const [settings, setSettingsState] = useState<KioskSettings>(() =>
    loadSettings(nameId ?? ""),
  );
  const [showSettings, setShowSettings] = useState(false);
  const [competitionName, setCompetitionName] = useState("");
  const channelRef = useRef<KioskChannel | null>(null);
  const resetTimerRef = useRef<any>(undefined);

  // Select the competition (same as CompetitionShell)
  const selectMutation = trpc.competition.select.useMutation({
    onSuccess: (data) => setCompetitionName(data.name),
  });

  // Fetch dashboard data for organizer logo
  const dashboard = trpc.competition.dashboard.useQuery(undefined, {
    enabled: selectMutation.isSuccess,
    staleTime: 5 * 60_000,
  });
  const organizerEventorId =
    dashboard.data?.organizer?.eventorId && dashboard.data.organizer.eventorId > 0
      ? dashboard.data.organizer.eventorId
      : undefined;

  useEffect(() => {
    if (nameId) selectMutation.mutate({ nameId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameId]);

  // Standalone mode: use DeviceManager for SI reader
  const { currentCard, readerStatus, connectReader, supported, lastDetectedCardNo } = useDeviceManager();

  const updateSettings = useCallback(
    (partial: Partial<KioskSettings>) => {
      setSettingsState((prev) => {
        const next = { ...prev, ...partial };
        saveSettings(nameId ?? "", next);
        return next;
      });
    },
    [nameId],
  );

  // ── Auto-reset timer ─────────────────────────────────────

  const scheduleReset = useCallback(
    (seconds?: number) => {
      clearTimeout(resetTimerRef.current);
      const delay = (seconds ?? settings.autoResetSeconds) * 1000;
      resetTimerRef.current = setTimeout(() => {
        setScreen({ mode: "idle" });
      }, delay);
    },
    [settings.autoResetSeconds],
  );

  useEffect(() => {
    return () => clearTimeout(resetTimerRef.current);
  }, []);

  // ── Card-done → next screen transition ─────────────────────
  const cardDoneTimerRef = useRef<any>(undefined);

  useEffect(() => {
    if (screen.mode !== "card-done") return;
    const nextScreen = screen.next;
    cardDoneTimerRef.current = setTimeout(() => {
      setScreen(nextScreen);
      // Schedule auto-reset for result screens
      if (nextScreen.mode === "readout" || nextScreen.mode === "pre-start") {
        scheduleReset();
      }
    }, 2000);
    return () => clearTimeout(cardDoneTimerRef.current);
  }, [screen, scheduleReset]);

  // ── Handle incoming kiosk messages (paired mode) ──────────

  useEffect(() => {
    if (!nameId) return;
    const channel = new KioskChannel(nameId);
    channelRef.current = channel;

    const unsub = channel.subscribe((msg: KioskMessage) => {
      switch (msg.type) {
        case "kiosk-ping":
          if (msg.from === "admin") {
            channel.send({ type: "kiosk-ping", from: "kiosk" });
          }
          break;

        case "card-reading":
          setScreen((prev) => {
            if (prev.mode === "registration-waiting") return prev;
            clearTimeout(resetTimerRef.current);
            return { mode: "reading", cardNumber: msg.cardNumber };
          });
          break;

        case "card-readout":
          setScreen((prev) => {
            if (prev.mode === "registration-waiting") return prev;
            clearTimeout(resetTimerRef.current);

            if (msg.card.action === "register") {
              // Skip card-done transition for registration — go directly to waiting
              return { mode: "registration-waiting", card: msg.card };
            }

            let nextScreen: KioskScreen;
            if (msg.card.action === "readout") {
              nextScreen = { mode: "readout", card: msg.card };
            } else if (msg.card.action === "pre-start") {
              nextScreen = { mode: "pre-start", card: msg.card };
            } else {
              return prev;
            }

            // Show "card done — remove card" briefly before the actual screen
            return { mode: "card-done", cardNumber: msg.card.cardNumber, next: nextScreen };
          });
          break;

        case "registration-state":
          setScreen((prev) => {
            if (prev.mode === "registration-waiting") {
              return { ...prev, form: msg.form };
            }
            return prev;
          });
          break;

        case "registration-complete":
          clearTimeout(resetTimerRef.current);
          setScreen({ mode: "registration-complete", runner: msg.runner });
          scheduleReset(20);
          break;

        case "kiosk-reset":
          clearTimeout(resetTimerRef.current);
          setScreen({ mode: "idle" });
          break;
      }
    });

    return () => {
      unsub();
      channel.close();
      channelRef.current = null;
    };
  }, [nameId, scheduleReset]);

  // ── Standalone mode: show "reading" screen on card detect ──

  const lastDetectedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!settings.standalone) return;
    if (lastDetectedCardNo == null || lastDetectedCardNo === lastDetectedRef.current) return;
    lastDetectedRef.current = lastDetectedCardNo;

    clearTimeout(resetTimerRef.current);
    setScreen({ mode: "reading", cardNumber: lastDetectedCardNo });
  }, [lastDetectedCardNo, settings.standalone]);

  // ── Standalone mode: react to DeviceManager card events ───

  const lastCardIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!settings.standalone) return;
    if (!currentCard || currentCard.id === lastCardIdRef.current) return;
    lastCardIdRef.current = currentCard.id;

    clearTimeout(resetTimerRef.current);
    const msg = recentCardToKioskMessage(currentCard);

    let nextScreen: KioskScreen;
    if (msg.card.action === "readout") {
      nextScreen = { mode: "readout", card: msg.card };
    } else if (msg.card.action === "pre-start") {
      nextScreen = { mode: "pre-start", card: msg.card };
    } else if (msg.card.action === "register") {
      nextScreen = { mode: "registration-waiting", card: msg.card };
    } else {
      return;
    }
    setScreen({ mode: "card-done", cardNumber: msg.card.cardNumber, next: nextScreen });
  }, [currentCard, settings.standalone, scheduleReset]);

  // ── Fullscreen toggle ─────────────────────────────────────

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => { });
    }
  };

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col select-none">
      {/* Minimal top bar — settings + fullscreen */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800/50">
        <div className="text-sm text-slate-400 truncate max-w-[60%]">
          {competitionName || nameId}
        </div>
        <div className="flex items-center gap-2">
          {settings.standalone && supported && (
            <button
              onClick={() => connectReader().catch(() => { })}
              className={`text-xs px-2 py-1 rounded ${readerStatus === "connected" || readerStatus === "reading"
                  ? "bg-emerald-600/30 text-emerald-300"
                  : "bg-slate-700 text-slate-400 hover:text-slate-200"
                }`}
            >
              {readerStatus === "connected" || readerStatus === "reading"
                ? "Reader active"
                : "Connect Reader"}
            </button>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-700 transition-colors"
            title="Settings"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            onClick={toggleFullscreen}
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-700 transition-colors"
            title="Toggle fullscreen"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <KioskSettingsPanel
          settings={settings}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Main content area */}
      <div className="flex-1 flex items-center justify-center p-8">
        {screen.mode === "idle" && (
          <IdleScreen
            competitionName={competitionName}
            organizerEventorId={organizerEventorId}
          />
        )}
        {screen.mode === "reading" && (
          <ReadingScreen cardNumber={screen.cardNumber} />
        )}
        {screen.mode === "card-done" && (
          <CardDoneScreen cardNumber={screen.cardNumber} />
        )}
        {screen.mode === "readout" && <ReadoutScreen card={screen.card} />}
        {screen.mode === "pre-start" && (
          <PreStartScreen card={screen.card} requireClearCheck={settings.requireClearCheck} />
        )}
        {screen.mode === "registration-waiting" && (
          <RegistrationWaitingScreen card={screen.card} form={screen.form} />
        )}
        {screen.mode === "registration-complete" && (
          <RegistrationCompleteScreen runner={screen.runner} />
        )}
      </div>
    </div>
  );
}

// ─── Settings Panel ─────────────────────────────────────────

function KioskSettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: KioskSettings;
  onChange: (partial: Partial<KioskSettings>) => void;
  onClose: () => void;
}) {
  return (
    <div className="bg-slate-800 border-b border-slate-700 px-6 py-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
            Kiosk Settings
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-sm">
            Close
          </button>
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.standalone}
            onChange={(e) => onChange({ standalone: e.target.checked })}
            className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-emerald-500 focus:ring-emerald-500"
          />
          <div>
            <div className="text-sm text-slate-200">Standalone mode</div>
            <div className="text-xs text-slate-400">
              Use own SI reader instead of receiving from admin window
            </div>
          </div>
        </label>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.requireClearCheck}
            onChange={(e) => onChange({ requireClearCheck: e.target.checked })}
            className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-emerald-500 focus:ring-emerald-500"
          />
          <div>
            <div className="text-sm text-slate-200">Require clear/check</div>
            <div className="text-xs text-slate-400">
              Verify card is cleared and checked before start (for start area kiosk)
            </div>
          </div>
        </label>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.writeToCard}
            onChange={(e) => onChange({ writeToCard: e.target.checked })}
            className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-emerald-500 focus:ring-emerald-500"
          />
          <div>
            <div className="text-sm text-slate-200">Write details to empty cards</div>
            <div className="text-xs text-slate-400">
              Save runner details to SI card during registration (with user consent)
            </div>
          </div>
        </label>

        <div>
          <label className="text-sm text-slate-200 block mb-1">
            Auto-reset after (seconds)
          </label>
          <input
            type="number"
            min={5}
            max={120}
            value={settings.autoResetSeconds}
            onChange={(e) =>
              onChange({ autoResetSeconds: Math.max(5, parseInt(e.target.value, 10) || 15) })
            }
            className="w-24 px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Idle Screen ────────────────────────────────────────────

// ─── Animated Card Insert Icon ──────────────────────────────

/**
 * SVG animation of an SI card sliding down into a reader bucket.
 * Uses CSS keyframes for the card movement.
 */
function CardInsertAnimation({ size = 160 }: { size?: number }) {
  return (
    <div className="inline-block" style={{ width: size, height: size }}>
      <style>{`
        @keyframes slideCard {
          0%, 100% { transform: translateY(-18px); }
          40%, 60% { transform: translateY(8px); }
        }
      `}</style>
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        {/* Reader bucket / station body */}
        <rect
          x="25" y="50" width="50" height="40" rx="6"
          fill="#334155" stroke="#475569" strokeWidth="2"
        />
        {/* Slot opening */}
        <rect x="35" y="48" width="30" height="6" rx="2" fill="#1e293b" />
        {/* SI card — animated */}
        <g style={{ animation: "slideCard 2.5s ease-in-out infinite" }}>
          {/* Card body */}
          <rect
            x="34" y="12" width="32" height="42" rx="4"
            fill="#10b981" stroke="#34d399" strokeWidth="1.5"
          />
          {/* Card chip */}
          <rect x="42" y="20" width="16" height="12" rx="2" fill="#065f46" />
          {/* Chip contacts */}
          <line x1="45" y1="23" x2="45" y2="29" stroke="#34d399" strokeWidth="0.8" />
          <line x1="48" y1="23" x2="48" y2="29" stroke="#34d399" strokeWidth="0.8" />
          <line x1="51" y1="23" x2="51" y2="29" stroke="#34d399" strokeWidth="0.8" />
          <line x1="54" y1="23" x2="54" y2="29" stroke="#34d399" strokeWidth="0.8" />
          {/* Card number text area */}
          <rect x="38" y="38" width="24" height="3" rx="1" fill="#065f46" opacity="0.5" />
          <rect x="40" y="44" width="20" height="2" rx="1" fill="#065f46" opacity="0.3" />
        </g>
        {/* Down arrow hint */}
        <path
          d="M50 94 L45 88 L55 88 Z"
          fill="#475569" opacity="0.5"
        />
      </svg>
    </div>
  );
}

const API_BASE = import.meta.env.VITE_API_URL ?? "";

function IdleScreen({
  competitionName,
  organizerEventorId,
}: {
  competitionName: string;
  organizerEventorId?: number;
}) {
  const serverTime = trpc.race.serverTime.useQuery(undefined, {
    refetchInterval: 1000,
  });

  return (
    <div className="text-center">
      {/* Competition branding */}
      <div className="mb-10">
        {organizerEventorId && (
          <img
            src={`${API_BASE}/api/club-logo/${organizerEventorId}?variant=large`}
            alt=""
            className="inline-block w-28 h-28 object-contain rounded-lg mb-4"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        {competitionName && (
          <h2 className="text-4xl font-bold text-slate-200 tracking-tight">
            {competitionName}
          </h2>
        )}
      </div>

      {/* Animated card insertion icon */}
      <div className="mb-10">
        <CardInsertAnimation />
      </div>

      <h1 className="text-7xl font-black text-white mb-4">
        Insert your SI card
      </h1>
      <p className="text-2xl text-slate-400 mb-8">
        Place your card in the reader and wait for the beep
      </p>

      {/* Clock */}
      {serverTime.data && (
        <div className="text-3xl font-mono text-slate-500 tabular-nums">
          {formatMeosTime(serverTime.data.deciseconds)}
        </div>
      )}
    </div>
  );
}

// ─── Reading Screen (card inserted, readout in progress) ────

function ReadingScreen({ cardNumber }: { cardNumber: number }) {
  return (
    <div className="text-center">
      <div className="mb-8">
        <div className="inline-block w-20 h-20 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" />
      </div>
      <h1 className="text-5xl font-black text-amber-400 mb-4">
        Reading card...
      </h1>
      <p className="text-2xl text-white mb-6">
        Do not remove SI card until the beep
      </p>
      <div className="text-xl text-slate-400 font-mono">
        Card {cardNumber}
      </div>
    </div>
  );
}

// ─── Card Done Screen (remove card prompt) ──────────────────

function CardDoneScreen({ cardNumber }: { cardNumber: number }) {
  return (
    <div className="text-center">
      <div className="mb-8">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-emerald-500/20 border-4 border-emerald-400">
          <svg className="w-12 h-12 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      </div>
      <h1 className="text-5xl font-black text-emerald-400 mb-4">
        Card read
      </h1>
      <p className="text-2xl text-white mb-6">
        You may remove your SI card
      </p>
      <div className="text-xl text-slate-400 font-mono">
        Card {cardNumber}
      </div>
    </div>
  );
}

// ─── Readout Screen ─────────────────────────────────────────

function ReadoutScreen({ card }: { card: KioskCardReadoutMessage["card"] }) {
  // Fetch full readout from server for detailed punch data
  const readout = trpc.cardReadout.readout.useQuery(
    { cardNo: card.cardNumber },
    { enabled: card.cardNumber > 0 },
  );

  const status = card.status;
  const isOK = status === "OK";
  const isMP = status === "MP";
  const isDNF = status === "DNF";

  return (
    <div className="w-full max-w-2xl mx-auto text-center">
      {/* Status icon */}
      <div className="mb-6">
        {isOK && (
          <div className="inline-flex items-center justify-center w-28 h-28 rounded-full bg-emerald-500/20 border-4 border-emerald-400">
            <svg className="w-16 h-16 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
        {isMP && (
          <div className="inline-flex items-center justify-center w-28 h-28 rounded-full bg-red-500/20 border-4 border-red-400">
            <svg className="w-16 h-16 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        )}
        {isDNF && (
          <div className="inline-flex items-center justify-center w-28 h-28 rounded-full bg-amber-500/20 border-4 border-amber-400">
            <svg className="w-16 h-16 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
          </div>
        )}
        {!isOK && !isMP && !isDNF && (
          <div className="inline-flex items-center justify-center w-28 h-28 rounded-full bg-blue-500/20 border-4 border-blue-400">
            <svg className="w-16 h-16 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
        )}
      </div>

      {/* Runner info */}
      <h1 className="text-5xl font-black mb-2">
        {card.runnerName || `Card ${card.cardNumber}`}
      </h1>
      {card.clubName && (
        <p className="text-2xl text-slate-400 mb-1">{card.clubName}</p>
      )}
      {card.className && (
        <p className="text-xl text-slate-500 mb-6">{card.className}</p>
      )}

      {/* Status + time */}
      <div className={`text-4xl font-bold mb-4 ${isOK ? "text-emerald-400" : isMP ? "text-red-400" : isDNF ? "text-amber-400" : "text-blue-400"
        }`}>
        {isOK && "Completed"}
        {isMP && "Missing Punch"}
        {isDNF && "Did Not Finish"}
        {!isOK && !isMP && !isDNF && (status || "Result")}
      </div>

      {card.runningTime != null && card.runningTime > 0 && (
        <div className="text-6xl font-black tabular-nums text-white mb-8">
          {formatRunningTime(card.runningTime)}
        </div>
      )}

      {/* Detailed punch info from server */}
      {readout.data?.found && (
        <div className="bg-slate-800 rounded-2xl p-6 text-left">
          <div className="grid grid-cols-3 gap-4 text-center mb-4">
            <div>
              <div className="text-sm text-slate-400">Controls</div>
              <div className="text-2xl font-bold">
                {readout.data.controls.filter((c) => c.status === "ok").length}/{readout.data.controls.length}
              </div>
            </div>
            {readout.data.course && (
              <>
                <div>
                  <div className="text-sm text-slate-400">Course</div>
                  <div className="text-2xl font-bold">{readout.data.course.name}</div>
                </div>
                <div>
                  <div className="text-sm text-slate-400">Length</div>
                  <div className="text-2xl font-bold">
                    {(readout.data.course.length / 1000).toFixed(1)} km
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Missing controls */}
          {readout.data.missingControls.length > 0 && (
            <div className="mt-4 p-4 bg-red-900/30 border border-red-700/50 rounded-xl">
              <div className="text-red-400 font-semibold mb-2">
                Missing controls ({readout.data.missingControls.length})
              </div>
              <div className="flex flex-wrap gap-2">
                {readout.data.missingControls.map((code, i) => (
                  <span
                    key={i}
                    className="px-3 py-1 bg-red-800/50 text-red-300 rounded-lg font-mono text-lg"
                  >
                    {code}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Pre-Start Screen ───────────────────────────────────────

function PreStartScreen({
  card,
  requireClearCheck,
}: {
  card: KioskCardReadoutMessage["card"];
  requireClearCheck: boolean;
}) {
  // Fetch runner details for start time and course
  const lookup = trpc.race.lookupByCard.useQuery(
    { cardNo: card.cardNumber },
    { enabled: card.cardNumber > 0 },
  );

  // Server time for countdown
  const serverTime = trpc.race.serverTime.useQuery(undefined, {
    refetchInterval: 1000,
  });

  const runner = lookup.data?.found ? lookup.data.runner : null;
  const course = lookup.data?.found ? lookup.data.course : null;
  const currentTimeDeci = serverTime.data?.deciseconds ?? 0;

  // Clear/check verification
  const hasCheck = card.checkTime != null && card.checkTime > 0;
  const hasClear = card.clearTime != null && card.clearTime > 0;
  const clearCheckOk = !requireClearCheck || (hasCheck && hasClear);

  // Countdown
  const timeToStart = runner?.startTime && runner.startTime > 0
    ? runner.startTime - currentTimeDeci
    : 0;
  const countdownMinutes = Math.floor(Math.abs(timeToStart) / 600);
  const countdownSeconds = Math.floor((Math.abs(timeToStart) % 600) / 10);
  const isPast = timeToStart < 0;

  return (
    <div className="w-full max-w-2xl mx-auto text-center">
      {/* Status badge */}
      <div className="mb-6">
        <div className={`inline-flex items-center gap-2 px-6 py-3 rounded-full text-lg font-bold ${clearCheckOk
            ? "bg-emerald-500/20 text-emerald-400 border-2 border-emerald-500/50"
            : "bg-red-500/20 text-red-400 border-2 border-red-500/50"
          }`}>
          <div className={`w-3 h-3 rounded-full ${clearCheckOk ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
          {clearCheckOk ? "Ready to Start" : "Card Not Ready"}
        </div>
      </div>

      {/* Runner info */}
      <h1 className="text-5xl font-black mb-2">
        {runner?.name || card.runnerName || `Card ${card.cardNumber}`}
      </h1>
      {(runner?.clubName || card.clubName) && (
        <p className="text-2xl text-slate-400 mb-1">
          {runner?.clubName || card.clubName}
        </p>
      )}
      {(runner?.className || card.className) && (
        <p className="text-xl text-slate-500 mb-6">
          {runner?.className || card.className}
        </p>
      )}

      {/* Clear/Check warnings */}
      {requireClearCheck && !clearCheckOk && (
        <div className="mb-6 p-4 bg-red-900/30 border border-red-700/50 rounded-xl max-w-md mx-auto">
          <div className="text-red-400 font-semibold text-lg mb-2">
            Card needs preparation
          </div>
          <div className="space-y-1 text-red-300">
            {!hasClear && <p>Card has not been cleared</p>}
            {!hasCheck && <p>Card has not been checked</p>}
          </div>
          <p className="text-red-400/70 mt-2 text-sm">
            Please clear and check at the check station before starting
          </p>
        </div>
      )}

      {/* Course info */}
      {course && (
        <div className="bg-slate-800 rounded-2xl p-6 mb-6 max-w-md mx-auto">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-sm text-slate-400">Course</div>
              <div className="text-xl font-bold">{course.name}</div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Length</div>
              <div className="text-xl font-bold">
                {(course.length / 1000).toFixed(1)} km
              </div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Controls</div>
              <div className="text-xl font-bold">{course.controlCount}</div>
            </div>
          </div>
        </div>
      )}

      {/* Start time with countdown */}
      {runner?.startTime != null && runner.startTime > 0 ? (
        <div className="mt-6">
          <div className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2">
            Start Time
          </div>
          <div className="text-7xl font-black tabular-nums text-emerald-400">
            {formatMeosTime(runner.startTime)}
          </div>
          {timeToStart !== 0 && (
            <div className={`mt-3 text-2xl font-semibold tabular-nums ${isPast ? "text-amber-400" : "text-emerald-300"
              }`}>
              {isPast ? "Started " : ""}
              {countdownMinutes > 0 && `${countdownMinutes}m `}
              {countdownSeconds}s
              {isPast ? " ago" : " to start"}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-6">
          <div className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2">
            Start Time
          </div>
          <div className="text-3xl font-bold text-slate-500">
            Not assigned
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Registration: Waiting Screen ───────────────────────────

function RegistrationWaitingScreen({
  card,
  form,
}: {
  card: KioskCardReadoutMessage["card"];
  form?: RegistrationFormState;
}) {
  return (
    <div className="text-center max-w-lg mx-auto">
      <div className="mb-8">
        <div className="inline-block w-16 h-16 border-4 border-emerald-300 border-t-transparent rounded-full animate-spin" />
      </div>
      <h1 className="text-4xl font-bold text-white mb-4">
        Registration in progress
      </h1>
      <p className="text-xl text-slate-400 mb-6">
        Please wait while your details are being entered
      </p>

      <div className="bg-slate-800 rounded-2xl p-6 text-left space-y-3">
        <InfoRow label="Card" value={String(form?.cardNo || card.cardNumber)} />
        {(form?.name || card.ownerData?.firstName) && (
          <InfoRow label="Name" value={form?.name || [card.ownerData?.firstName, card.ownerData?.lastName].filter(Boolean).join(" ")} />
        )}
        {form?.clubName && (
          <div className="flex justify-between items-center py-1 border-b border-slate-700/50">
            <span className="text-slate-400 text-sm">Club</span>
            <span className="text-white font-medium text-lg flex items-center gap-2">
              {form.clubEventorId && (
                <span className="inline-flex bg-white rounded p-0.5">
                  <ClubLogo eventorId={form.clubEventorId} size="md" />
                </span>
              )}
              {form.clubName}
            </span>
          </div>
        )}
        {form?.className && <InfoRow label="Class" value={form.className} />}
        {form?.paymentMode && (
          <InfoRow
            label="Payment"
            value={form.paymentMode === "billed" ? "Invoice" : form.paymentMode === "swish" ? "Swish" : form.paymentMode === "card" ? "Card" : "Pay on site"}
          />
        )}
        {form?.fee != null && form.fee > 0 && form.paymentMode && form.paymentMode !== "billed" && (
          <InfoRow label="Amount" value={`${form.fee} kr`} />
        )}
      </div>

      {/* Swish QR code — only show once amount is known */}
      {form?.paymentMode === "swish" && form.swishNumber && form.fee != null && form.fee > 0 && (
        <div className="mt-6">
          <div className="bg-white inline-block p-4 rounded-2xl">
            <div className="relative inline-block">
              <QRCodeSVG
                value={`https://app.swish.nu/1/p/sw/?sw=${form.swishNumber}&amt=${form.fee}&msg=${encodeURIComponent([form.competitionName, form.className].filter(Boolean).join(" - ") || "Registration")}`}
                size={200}
                level="H"
              />
              {/* White circle mask + Swish icon overlay (per Swish design spec) */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-white flex items-center justify-center">
                <img src={swishIcon} alt="Swish" className="w-10 h-10" />
              </div>
            </div>
          </div>
          <p className="text-slate-400 text-sm mt-3">Scan with Swish to pay {form.fee} kr</p>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex justify-between items-center py-1 border-b border-slate-700/50 last:border-0">
      <span className="text-slate-400 text-sm">{label}</span>
      <span className="text-white font-medium text-lg">{value}</span>
    </div>
  );
}

// ─── Registration: Complete Screen ──────────────────────────

function RegistrationCompleteScreen({
  runner,
}: {
  runner: { name: string; className: string; clubName: string; startTime: string; cardNo: number; clubEventorId?: number };
}) {
  return (
    <div className="text-center max-w-lg mx-auto">
      {/* Success icon */}
      <div className="mb-6">
        <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-emerald-500/20 border-4 border-emerald-400">
          <svg className="w-14 h-14 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      </div>

      <h1 className="text-4xl font-bold text-emerald-400 mb-2">
        Registration Complete!
      </h1>
      <p className="text-2xl text-white font-semibold mb-1">{runner.name}</p>
      <p className="text-xl text-slate-400 mb-6 flex items-center justify-center gap-2">
        {runner.clubEventorId && (
          <span className="inline-flex bg-white rounded p-0.5">
            <ClubLogo eventorId={runner.clubEventorId} size="lg" />
          </span>
        )}
        {runner.clubName} &middot; {runner.className}
      </p>

      <div className="bg-slate-800 rounded-2xl p-6 max-w-sm mx-auto">
        <div className="text-sm text-slate-400 uppercase tracking-wider mb-1">
          Start
        </div>
        {runner.startTime ? (
          <div className="text-5xl font-black tabular-nums text-emerald-400">
            {runner.startTime}
          </div>
        ) : (
          <div className="text-3xl font-bold text-emerald-400">
            Free start
          </div>
        )}
      </div>

      <p className="text-slate-500 mt-6 text-sm">
        Please proceed to the start area. Good luck!
      </p>
    </div>
  );
}
