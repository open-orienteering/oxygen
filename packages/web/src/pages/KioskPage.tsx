/**
 * Kiosk Mode — user-facing fullscreen display.
 *
 * States: idle → readout | pre-start | registration
 *
 * In paired mode, receives card events via BroadcastChannel from admin.
 * In standalone mode, uses its own DeviceManager + SI reader.
 */

import { isFreshSince, shouldAutoPrint } from "../lib/kiosk-print";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../lib/trpc";
import { ensureEventCache } from "../lib/offline/persister";
import { formatMeosTime, formatRunningTime, RunnerStatus } from "@oxygen/shared";
import {
  KioskChannel,
  type KioskMessage,
  type KioskCardReadoutMessage,
  type RegistrationFormState,
} from "../lib/kiosk-channel";
import swishIcon from "../assets/swish-icon.svg";
import { ClubLogo } from "../components/ClubLogo";
import { MapPanel } from "../components/MapPanel";
import { useDeviceManager } from "../context/DeviceManager";
import { recentCardToKioskMessage } from "../lib/kiosk-channel";
import { shouldProcessStandaloneCard } from "../lib/kiosk-standalone-routing";
import { getClubLogoUrl } from "../lib/club-logo";
import { SiCardAnimation } from "../components/SiCardAnimation";
import { useEventClock } from "../hooks/useEventClock";
import { useStationSync } from "../hooks/useStationSync";
import { useEventQueue } from "../hooks/useEventQueue";
import { KioskAccessGate } from "../components/KioskAccessGate";
import { shouldShowStandaloneReadFailure } from "../lib/read-failure";

// Registration-waiting watchdog timeout. E2E hook: tests override via
// localStorage (set in an init script, i.e. before this module loads) so
// they don't have to wait out the full production timeout — see
// registration-dialog.spec.ts.
/** How long "card not read" stays up before the kiosk returns to idle. */
const READ_FAILED_SECONDS = 8;
const WATCHDOG_MS = Number(localStorage.getItem("oxygenKioskWatchdogMs") ?? 15_000);

// ─── Types ──────────────────────────────────────────────────

type KioskScreen =
  | { mode: "idle" }
  | { mode: "reading"; cardNumber: number }
  | { mode: "read-failed"; cardNumber: number }
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
  return (
    <KioskAccessGate>
      <KioskPageBody />
    </KioskAccessGate>
  );
}

function KioskPageBody() {
  const utils = trpc.useUtils();
  const { t } = useTranslation("kiosk");
  const { nameId } = useParams<{ nameId: string }>();
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<KioskScreen>({ mode: "idle" });
  const [settings, setSettingsState] = useState<KioskSettings>(() =>
    loadSettings(nameId ?? ""),
  );
  const [showSettings, setShowSettings] = useState(false);
  const [competitionName, setCompetitionName] = useState("");
  const channelRef = useRef<KioskChannel | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const screenRef = useRef<KioskScreen>(screen);
  // Tracks the last standalone card that was fully processed {id, action}.
  // Cleared on every idle transition so the same card can re-trigger after reset.
  const lastProcessedRef = useRef<{ id: string; action: string } | null>(null);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  // Select the competition (same as CompetitionShell)
  // `networkMode: "always"`: after an `offline` event a paused select would
  // never settle (WEB-03).
  const selectMutation = trpc.competition.select.useMutation({
    networkMode: "always",
    onSuccess: (data) => setCompetitionName(data.name),
  });
  // The cache is this event's (ensureEventCache resolved). The station runs
  // from it whether or not the server confirmed the event: a kiosk reloaded
  // during an outage keeps its runner list, name and logo (WEB-03).
  const [cacheClaimed, setCacheClaimed] = useState(false);

  // Pre-fetch and persist all competition data for offline use
  useStationSync(cacheClaimed);

  // Fetch dashboard data for organizer logo
  const dashboard = trpc.competition.dashboard.useQuery(undefined, {
    enabled: cacheClaimed,
    staleTime: 5 * 60_000,
  });
  const shownName = competitionName || dashboard.data?.competition?.name || "";
  const organizerEventorId =
    dashboard.data?.organizer?.eventorId && dashboard.data.organizer.eventorId > 0
      ? dashboard.data.organizer.eventorId
      : undefined;

  useEffect(() => {
    if (!nameId) return;
    let cancelled = false;
    // The cache belongs to one event (MC-04); claim it before selecting so the
    // standalone readout path never computes from another event's runners.
    setCacheClaimed(false);
    void ensureEventCache(queryClient, nameId).then(() => {
      if (cancelled) return;
      setCacheClaimed(true);
      selectMutation.mutate({ nameId });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameId]);

  // Standalone mode: use DeviceManager for SI reader
  const { currentCard, readerStatus, openReaderDialog, supported, lastDetectedCardNo, lastReadFailure } = useDeviceManager();
  // The kiosk route sits outside CompetitionShell, so it drains its own outbox
  // (SYNC-03): readouts taken while the server was unreachable go out when it
  // is back, and the operator sees how many are waiting.
  const { pendingCount, failedCount, needsSignIn } = useEventQueue(nameId);

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
        lastProcessedRef.current = null;
      }, delay);
    },
    [settings.autoResetSeconds],
  );

  useEffect(() => {
    return () => clearTimeout(resetTimerRef.current);
  }, []);

  // ── Registration-waiting watchdog ─────────────────────────
  // If no admin messages arrive for 15s while in registration-waiting, reset to idle.
  // Admin sends registration-state heartbeat every 2s AND kiosk-ping every 5s,
  // so 15s = 3 missed pings — resilient while still recovering from a dead admin.
  const registrationWatchdogRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(registrationWatchdogRef.current);
    if (screen.mode === "registration-waiting") {
      registrationWatchdogRef.current = setTimeout(() => {
        setScreen({ mode: "idle" });
        lastProcessedRef.current = null;
      }, WATCHDOG_MS);
    }
    return () => clearTimeout(registrationWatchdogRef.current);
  }, [screen]);

  // ── Play beep when card readout completes ───────────────────
  const prevScreenModeRef = useRef(screen.mode);
  useEffect(() => {
    const prev = prevScreenModeRef.current;
    prevScreenModeRef.current = screen.mode;
    // No beep when the read failed: the reader did not beep either.
    if (
      prev === "reading" &&
      screen.mode !== "reading" &&
      screen.mode !== "idle" &&
      screen.mode !== "read-failed"
    ) {
      playReadoutBeep();
    }
  }, [screen.mode]);

  // ── Card-done → next screen transition ─────────────────────
  const cardDoneTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
            // Admin is still alive — keep registration-waiting alive
            if (screenRef.current.mode === "registration-waiting") {
              clearTimeout(registrationWatchdogRef.current);
              registrationWatchdogRef.current = setTimeout(() => {
                setScreen({ mode: "idle" });
                lastProcessedRef.current = null;
              }, WATCHDOG_MS);
            }
          }
          break;

        case "card-reading":
          setScreen((prev) => {
            if (prev.mode === "registration-waiting") return prev;
            clearTimeout(resetTimerRef.current);
            return { mode: "reading", cardNumber: msg.cardNumber };
          });
          break;

        case "card-read-failed":
          // Only the reading/idle screens give way: a result or a
          // registration in progress is not disturbed by a failed read.
          if (screenRef.current.mode === "reading" || screenRef.current.mode === "idle") {
            setScreen({ mode: "read-failed", cardNumber: msg.cardNumber });
            scheduleReset(READ_FAILED_SECONDS);
          }
          break;

        case "card-readout":
          setScreen((prev) => {
            clearTimeout(resetTimerRef.current);

            if (msg.card.action === "register") {
              // Don't re-enter registration if already in registration-waiting
              if (prev.mode === "registration-waiting") return prev;
              // Skip card-done transition for registration — go directly to waiting
              return { mode: "registration-waiting", card: msg.card };
            }

            // Non-register actions (pre-start, readout) always take priority —
            // they override registration-waiting if the DB lookup corrected the action
            let nextScreen: KioskScreen;
            if (msg.card.action === "readout") {
              nextScreen = { mode: "readout", card: msg.card };
            } else if (msg.card.action === "pre-start") {
              nextScreen = { mode: "pre-start", card: msg.card };
            } else {
              return prev;
            }

            // Skip card-done transition — go directly to result screen
            scheduleReset();
            return nextScreen;
          });
          break;

        case "registration-state":
          // Reset watchdog — admin is still alive
          clearTimeout(registrationWatchdogRef.current);
          registrationWatchdogRef.current = setTimeout(() => {
            setScreen({ mode: "idle" });
            lastProcessedRef.current = null;
          }, WATCHDOG_MS);
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

        case "readout-applied":
          // The admin tab wrote the result: refetch what the screen shows.
          utils.cardReadout.readout.invalidate({ cardNo: msg.cardNumber });
          utils.runner.findByCard.invalidate({ cardNo: msg.cardNumber });
          utils.race.finishReceipt.invalidate();
          break;

        case "kiosk-reset":
          clearTimeout(resetTimerRef.current);
          setScreen({ mode: "idle" });
          lastProcessedRef.current = null;
          break;

        case "card-removed":
          setScreen((prev) => {
            // Only reset if in "reading" state — don't disrupt readout/registration
            if (prev.mode === "reading") {
              return { mode: "idle" };
            }
            return prev;
          });
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
    if (lastDetectedCardNo == null) {
      // The same card inserted again after a removal or a failed read must
      // show the reading screen again.
      lastDetectedRef.current = null;
      return;
    }
    if (lastDetectedCardNo === lastDetectedRef.current) return;
    lastDetectedRef.current = lastDetectedCardNo;

    clearTimeout(resetTimerRef.current);
    setScreen({ mode: "reading", cardNumber: lastDetectedCardNo });
  }, [lastDetectedCardNo, settings.standalone]);

  // ── Standalone mode: a card the reader could not read (SI-05) ──

  // Starts at the failure already present on mount, so a failure from before
  // the kiosk opened (or before it went standalone) is not replayed.
  const lastFailureSeqRef = useRef(lastReadFailure?.seq ?? 0);

  useEffect(() => {
    if (!lastReadFailure) return;
    if (lastReadFailure.seq === lastFailureSeqRef.current) return;
    lastFailureSeqRef.current = lastReadFailure.seq;
    if (!settings.standalone) return;
    // lastDetectedCardNo is the committed detection of the same render, so a
    // detection of another card in the same tick wins over the failure.
    if (shouldShowStandaloneReadFailure(lastReadFailure, lastDetectedCardNo, screenRef.current.mode)) {
      setScreen({ mode: "read-failed", cardNumber: lastReadFailure.cardNumber });
      scheduleReset(READ_FAILED_SECONDS);
    }
  }, [lastReadFailure, lastDetectedCardNo, settings.standalone, scheduleReset]);

  // ── Standalone mode: react to DeviceManager card events ───

  useEffect(() => {
    if (!settings.standalone) return;
    if (!shouldProcessStandaloneCard(currentCard, lastProcessedRef.current)) return;
    lastProcessedRef.current = { id: currentCard!.id, action: currentCard!.action };

    clearTimeout(resetTimerRef.current);
    const msg = recentCardToKioskMessage(currentCard!);

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
    if (nextScreen.mode === "readout" || nextScreen.mode === "pre-start") {
      scheduleReset();
    }
    setScreen(nextScreen);
  }, [currentCard, settings.standalone, scheduleReset]);

  // ── Print delegation ─────────────────────────────────────
  // Delegate printing to the admin tab via BroadcastChannel — it holds the
  // printer connection. The admin shell fetches all receipt data (logo, QR,
  // custom message) itself, so the kiosk only needs to pass the runner ID.
  const handlePrint = useCallback(
    (runnerId: number) => {
      channelRef.current?.send({ type: "kiosk-print-receipt", runnerId });
    },
    [],
  );

  // One automatic receipt per read, also when the read's screen remounts
  // (its error boundary's "Try again").
  const printedReadsRef = useRef(new Set<number>());
  // A number per read on the readout screen: a new one when the screen
  // enters readout or shows another recent card; updates of the same read
  // keep it. Each read mounts its own readout screen.
  const readSeq = useRef({ seq: 0, mode: "idle" as KioskScreen["mode"], cardId: "" });
  if (screen.mode === "readout") {
    const r = readSeq.current;
    if (r.mode !== "readout" || r.cardId !== screen.card.id) r.seq++;
    r.cardId = screen.card.id;
  }
  readSeq.current.mode = screen.mode;
  const currentRead = readSeq.current.seq;
  const printOnce = useCallback(
    (read: number, runnerId: number) => {
      if (printedReadsRef.current.has(read)) return;
      printedReadsRef.current.add(read);
      handlePrint(runnerId);
    },
    [handlePrint],
  );

  // Toggle the admin's "print registration receipt" flag from the kiosk so
  // a runner can opt in (or back out) before submission.
  const handleRequestRegistrationReceipt = useCallback(
    (printReceipt: boolean) => {
      channelRef.current?.send({
        type: "kiosk-request-registration-receipt",
        printReceipt,
      });
    },
    [],
  );

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
          {shownName || nameId}
        </div>
        <div className="flex items-center gap-2">
          {(pendingCount > 0 || failedCount > 0) && (
            <span
              data-testid="kiosk-sync-badge"
              data-pending={pendingCount}
              data-failed={failedCount}
              className="text-xs px-2 py-1 rounded bg-amber-600/30 text-amber-200"
            >
              {failedCount > 0
                ? t("syncFailed", { count: failedCount })
                : needsSignIn
                  ? t("syncNeedsSignIn", { count: pendingCount })
                  : t("syncPending", { count: pendingCount })}
            </span>
          )}
          {settings.standalone && supported && (
            <button
              data-testid="reader-menu"
              onClick={openReaderDialog}
              className={`text-xs px-2 py-1 rounded ${readerStatus === "connected" || readerStatus === "reading"
                  ? "bg-emerald-600/30 text-emerald-300"
                  : "bg-slate-700 text-slate-400 hover:text-slate-200"
                }`}
            >
              {readerStatus === "connected" || readerStatus === "reading"
                ? <span data-testid="reader-status">{t("readerActive")}</span>
                : t("connectReader")}
            </button>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-700 transition-colors"
            title={t("settings")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            onClick={toggleFullscreen}
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-700 transition-colors"
            title={t("toggleFullscreen")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>
      </div>

      {/* A read that reached neither the server nor this device's outbox */}
      {settings.standalone &&
        (currentCard?.saveState === "not-saved" || currentCard?.saveState === "no-competition") && (
          <div
            role="alert"
            data-testid="kiosk-not-saved"
            className="px-4 py-2 bg-red-700 text-white text-center text-sm"
          >
            {currentCard.saveState === "no-competition" ? t("noCompetition") : t("notSaved")}
          </div>
        )}

      {/* The USB reader was unplugged or its port failed (SI-18) */}
      {settings.standalone && supported && readerStatus === "error" && (
        <div
          role="alert"
          data-testid="kiosk-reader-disconnected"
          className="px-4 py-2 bg-red-700 text-white text-center text-sm"
        >
          {t("readerDisconnected")}
        </div>
      )}

      {/* Settings panel */}
      {showSettings && (
        <KioskSettingsPanel
          settings={settings}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Main content area */}
      <div className="flex-1 flex items-center justify-center px-4 py-4">
        {(screen.mode === "idle" || screen.mode === "reading" || screen.mode === "read-failed" || screen.mode === "card-done") ? (
          <div className="text-center">
            {/* Competition branding — always visible to keep layout stable */}
            <div className="mb-4">
              {organizerEventorId && (
                <img
                  src={getClubLogoUrl(organizerEventorId)}
                  alt=""
                  className="inline-block w-28 h-28 object-contain rounded-lg mb-4"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              )}
              {shownName && (
                <h2 className="text-4xl font-bold text-slate-200 tracking-tight">
                  {shownName}
                </h2>
              )}
            </div>

            {/* Reader animation — fixed position, overflow clipped */}
            <div className="mb-6 overflow-hidden mx-auto" style={{ paddingTop: 100 }}>
              <SiCardAnimation
                cardNumber={
                  screen.mode === "idle"
                    ? (lastDetectedCardNo ?? undefined)
                    : screen.cardNumber
                }
                inserted={screen.mode !== "idle"}
              />
            </div>

            {/* Screen-specific content below the reader — fixed height to prevent reader shift */}
            <div className="min-h-[220px]">
              {screen.mode === "idle" && <IdleContent />}
              {screen.mode === "reading" && <ReadingContent cardNumber={screen.cardNumber} />}
              {screen.mode === "read-failed" && <ReadFailedContent cardNumber={screen.cardNumber} />}
              {screen.mode === "card-done" && <CardDoneContent cardNumber={screen.cardNumber} />}
            </div>
          </div>
        ) : (
          <>
            {screen.mode === "readout" && (
              // Keyed by the read: a new card is a new screen (its own print
              // guard), and a screen that throws does not take the kiosk down.
              <ErrorBoundary key={currentRead} variant="dark">
                <ReadoutScreen card={screen.card} onPrint={(runnerId) => printOnce(currentRead, runnerId)} />
              </ErrorBoundary>
            )}
            {screen.mode === "pre-start" && (
              <PreStartScreen card={screen.card} requireClearCheck={settings.requireClearCheck} />
            )}
            {screen.mode === "registration-waiting" && (
              <RegistrationWaitingScreen
                card={screen.card}
                form={screen.form}
                onRequestReceipt={handleRequestRegistrationReceipt}
              />
            )}
            {screen.mode === "registration-complete" && (
              <RegistrationCompleteScreen runner={screen.runner} />
            )}
          </>
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
  const { t } = useTranslation("kiosk");
  return (
    <div className="bg-slate-800 border-b border-slate-700 px-6 py-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
            {t("settings")}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-sm">
            {t("close")}
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
            <div className="text-sm text-slate-200">{t("standaloneMode")}</div>
            <div className="text-xs text-slate-400">
              {t("standaloneModeDesc")}
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
            <div className="text-sm text-slate-200">{t("requireClearCheck")}</div>
            <div className="text-xs text-slate-400">
              {t("requireClearCheckDesc")}
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
            <div className="text-sm text-slate-200">{t("writeToCard")}</div>
            <div className="text-xs text-slate-400">
              {t("writeToCardDesc")}
            </div>
          </div>
        </label>

        <div>
          <label className="text-sm text-slate-200 block mb-1">
            {t("autoResetLabel")}
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

// ─── Idle Content (text + clock below the shared reader) ────

function IdleContent() {
  const { t } = useTranslation("kiosk");
  const fmt = useCallback((d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }), []);
  const [clock, setClock] = useState(() => fmt(new Date()));

  useEffect(() => {
    const id = setInterval(() => setClock(fmt(new Date())), 1000);
    return () => clearInterval(id);
  }, [fmt]);

  return (
    <>
      <h1 className="text-7xl font-black text-white mb-4">
        {t("insertCard")}
      </h1>
      <p className="text-2xl text-slate-400 mb-8">
        {t("insertCardHint")}
      </p>
      <div className="text-3xl font-mono text-slate-500 tabular-nums">
        {clock}
      </div>
    </>
  );
}

// ─── Reading Content (status text below the shared reader) ──

function ReadingContent({ cardNumber }: { cardNumber: number }) {
  const { t } = useTranslation("kiosk");
  return (
    <>
      <div className="mb-4 flex items-center justify-center gap-3">
        <div className="inline-block w-8 h-8 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" />
        <h1 className="text-4xl font-black text-amber-400">
          {t("readingCard")}
        </h1>
      </div>
      <p className="text-2xl text-white mb-4">
        {t("doNotRemove")}
      </p>
      <div className="text-xl text-slate-400 font-mono">
        {t("cardNumber", { number: cardNumber })}
      </div>
    </>
  );
}

// ─── Read Failed Content (the card could not be read, SI-05) ─

function ReadFailedContent({ cardNumber }: { cardNumber: number }) {
  const { t } = useTranslation("kiosk");
  return (
    <div data-testid="kiosk-read-failed">
      <div className="mb-4 flex items-center justify-center gap-3">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-red-500/20 border-4 border-red-400">
          <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h1 className="text-4xl font-black text-red-400">{t("cardNotRead")}</h1>
      </div>
      <p className="text-2xl text-white mb-4">{t("cardNotReadHint")}</p>
      <div className="text-xl text-slate-400 font-mono">
        {t("cardNumber", { number: cardNumber })}
      </div>
    </div>
  );
}

// ─── Card Done Content (status text below the shared reader) ─

function CardDoneContent({ cardNumber }: { cardNumber: number }) {
  const { t } = useTranslation("kiosk");
  return (
    <>
      <div className="mb-4 flex items-center justify-center gap-3">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500/20 border-4 border-emerald-400">
          <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-4xl font-black text-emerald-400">
          {t("cardRead")}
        </h1>
      </div>
      <p className="text-2xl text-white mb-4">
        {t("removeCard")}
      </p>
      <div className="text-xl text-slate-400 font-mono">
        {t("cardNumber", { number: cardNumber })}
      </div>
    </>
  );
}

// ─── Card readout beep (Web Audio API) ──────────────────────

function playReadoutBeep() {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1000, ctx.currentTime);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // AudioContext not available — ignore
  }
}

// ─── Rental card sound (Web Audio API) ──────────────────────

function playRentalCardSound() {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);

    // Three short ascending beeps — distinct from any "success" sound
    const freqs = [660, 880, 1100];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.connect(gain);
      const start = ctx.currentTime + i * 0.22;
      osc.start(start);
      osc.stop(start + 0.18);
    });

    setTimeout(() => ctx.close(), 1500);
  } catch {
    // AudioContext not available — ignore
  }
}

// ─── Readout Screen ─────────────────────────────────────────

function ReadoutScreen({
  card,
  onPrint,
}: {
  card: KioskCardReadoutMessage["card"];
  onPrint: (runnerId: number) => void;
}) {
  const { t } = useTranslation("kiosk");
  const printedRef = useRef(false);
  // Answers older than this are cached rows of an earlier read (WEB-02).
  const [mountedAt] = useState(() => Date.now());

  // 1. Check DB state for this runner
  const dbRunner = trpc.runner.findByCard.useQuery(
    { cardNo: card.cardNumber },
    { enabled: card.cardNumber > 0 },
  );

  // 3. Fetch full readout + receipt data
  const readout = trpc.cardReadout.readout.useQuery(
    { cardNo: card.cardNumber },
    { enabled: card.cardNumber > 0 },
  );

  const receipt = trpc.race.finishReceipt.useQuery(
    { runnerId: dbRunner.data?.id ?? 0 },
    { enabled: !!dbRunner.data?.id },
  );

  // Derive status from readout (more accurate than card.status since it evaluates punches)
  const readoutStatus = readout.data?.found ? readout.data.timing.status : null;
  const readoutRunningTime = readout.data?.found ? readout.data.timing.runningTime : 0;
  // Raw running time for the small "raw 35:42" subtitle when the
  // canonical (adjusted) time deducted any NoTiming/BadNoTiming legs.
  const readoutRawRunningTime = readout.data?.found ? readout.data.timing.rawRunningTime : 0;
  const readoutAdjustment = readout.data?.found ? readout.data.timing.runningTimeAdjustment : 0;

  // Fallback to card-level status before readout loads
  const displayStatus = readoutStatus != null ? readoutStatus : (
    card.status === "OK" ? RunnerStatus.OK :
    card.status === "MP" ? RunnerStatus.MissingPunch :
    card.status === "DNF" ? RunnerStatus.DNF : 0
  );
  const displayRunningTime = readoutRunningTime > 0 ? readoutRunningTime : (card.runningTime ?? 0);
  const isOK = displayStatus === RunnerStatus.OK;
  const isMP = displayStatus === RunnerStatus.MissingPunch;
  const isDNF = displayStatus === RunnerStatus.DNF;

  // 4. Auto-print receipt, from answers fetched for this screen only
  // (WEB-02): a cached row of an earlier read may name another runner.
  useEffect(() => {
    if (!shouldAutoPrint({
      alreadyPrinted: printedRef.current,
      runner: dbRunner.data,
      receipt: receipt.data,
      runnerFresh: isFreshSince(dbRunner, mountedAt),
      receiptFresh: isFreshSince(receipt, mountedAt),
    })) return;
    printedRef.current = true;
    onPrint(dbRunner.data!.id);
  }, [receipt, dbRunner, mountedAt, onPrint]);

  // Derive rental card status: from readout data (authoritative) or card message (fast path)
  const isRentalCard = readout.data?.found ? readout.data.isRentalCard : card.isRentalCard;

  // Play a distinct sound when a rental card is detected
  const rentalSoundPlayedRef = useRef(false);
  useEffect(() => {
    if (!isRentalCard || rentalSoundPlayedRef.current) return;
    rentalSoundPlayedRef.current = true;
    playRentalCardSound();
  }, [isRentalCard]);

  // 5. MapPanel info — always show when course data exists
  const courseMapInfo = useMemo(() => {
    if (!readout.data?.found || !readout.data.course) return null;
    const d = readout.data;
    const punchStatusByCode: Record<string, "ok" | "missing" | "extra"> = {};
    for (const c of d.controls) {
      // A skipped position (Bad / Optional / BadNoTiming) that the runner
      // did NOT punch must not surface as a missing red marker on the map
      // — it was never required. Skipped + ok (punched anyway) renders
      // the same green as a normal hit. NoTiming positions evaluate
      // identically to required for map status purposes (the runner
      // still has to punch them; the leg time is what's adjusted).
      if (c.positionMode === "skipped" && c.status === "missing") continue;
      punchStatusByCode[String(c.controlCode)] = c.status as "ok" | "missing" | "extra";
    }
    // Don't overwrite an "ok" slot with "extra" — happens when the runner punched a control
    // out of order (e.g. 1,2,3,5,4,5,6): the early punch for code 5 lands in extraPunches
    // but the correctly-matched slot is already "ok" and should stay green.
    for (const ep of d.extraPunches) {
      if (punchStatusByCode[String(ep.controlCode)] !== "ok")
        punchStatusByCode[String(ep.controlCode)] = "extra";
    }
    // Skipped controls that the runner missed are not focused either —
    // they're not actionable feedback for the runner.
    const focusControlCodes = [
      ...d.controls
        .filter((c) => c.status === "missing" && c.positionMode === "required")
        .map((c) => String(c.controlCode)),
      ...d.extraPunches.map((ep) => String(ep.controlCode)),
    ];
    return { courseName: d.course!.name, punchStatusByCode, focusControlCodes };
  }, [readout.data]);

  // Auto-scale to fit viewport (works in both landscape and portrait)
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const updateScale = () => {
      // Reset scale to measure natural height
      content.style.transform = "none";
      const naturalHeight = content.scrollHeight;
      // Available height = viewport minus kiosk top bar (~40px) and content padding (2×16px)
      const availableHeight = window.innerHeight - 72;
      if (naturalHeight > availableHeight && naturalHeight > 0) {
        const newScale = Math.max(0.45, availableHeight / naturalHeight);
        content.style.transform = `scale(${newScale})`;
      } else {
        content.style.transform = "none";
      }
    };

    // Observe content size changes (e.g. when readout data loads)
    const observer = new ResizeObserver(updateScale);
    observer.observe(content);
    window.addEventListener("resize", updateScale);
    updateScale();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateScale);
    };
  }, [readout.data, receipt.data]);

  const hasMap = !!courseMapInfo;

  return (
    <div
      ref={contentRef}
      className={`w-full mx-auto ${hasMap ? "" : "max-w-4xl"}`}
      style={{ transformOrigin: "top center" }}
    >
      {/* Two-column layout on wide screens when map is available */}
      <div className={hasMap ? "flex gap-6 items-stretch" : ""}>
        {/* Left column: course map — stretches to match right column height */}
        {courseMapInfo && (
          <div className="flex-1 min-w-0 rounded-2xl overflow-hidden">
            <MapPanel
              highlightCourseName={courseMapInfo.courseName}
              filterMode="course"
              height="calc(100vh - 110px)"
              fitToControls
              hideToolbar
              allow3d={false}
              punchStatusByCode={courseMapInfo.punchStatusByCode}
              focusControlCodes={courseMapInfo.focusControlCodes}
            />
          </div>
        )}

        {/* Right column (or single column when no map): runner info */}
        <div className={`text-center ${hasMap ? "w-[28rem] flex-shrink-0" : ""}`}>
          {/* Status icon */}
          <div className="mb-2">
            <StatusIcon status={displayStatus} />
          </div>

          {/* Runner info */}
          <h1 className="text-4xl font-black mb-1">
            {card.runnerName || t("cardNumber", { number: card.cardNumber })}
          </h1>
          {card.clubName && (
            <p className="text-xl text-slate-400">{card.clubName}</p>
          )}
          {card.className && (
            <p className="text-lg text-slate-500 mb-2">{card.className}</p>
          )}

          {/* Status + time */}
          <div className={`text-3xl font-bold mb-1 ${isOK ? "text-emerald-400" : isMP ? "text-red-400" : isDNF ? "text-amber-400" : "text-blue-400"}`}>
            {isOK && t("completed")}
            {isMP && t("missingPunch")}
            {isDNF && t("didNotFinish")}
            {!isOK && !isMP && !isDNF && (card.status || t("result"))}
          </div>
          {/* The runner's screen never accepts another variant (F6c): the desk does. */}
          {isMP && (
            <p data-testid="kiosk-see-official" className="text-lg text-red-300 mb-1">
              {t("seeOfficial")}
            </p>
          )}

          {displayRunningTime > 0 && (
            <>
              <div className="text-5xl font-black tabular-nums text-white mb-1">
                {formatRunningTime(displayRunningTime)}
              </div>
              {/* When NoTiming / BadNoTiming legs were deducted, show the
                  raw card duration as a small subtitle so the runner sees
                  both numbers and understands why they differ. */}
              {readoutAdjustment > 0 && readoutRawRunningTime > 0 && (
                <div className="text-sm text-slate-400 mb-1" data-testid="kiosk-raw-running-time">
                  {t("rawTime", { time: formatRunningTime(readoutRawRunningTime) })}
                </div>
              )}
            </>
          )}

          {/* Position in class */}
          {receipt.data?.position && (
            <div className="text-lg text-slate-300 mb-2">
              {t("positionInClass", {
                rank: receipt.data.position.rank,
                total: receipt.data.position.total,
              })}
            </div>
          )}

          {/* Rental card banner */}
          {isRentalCard && (
            <div className="mb-3 p-4 bg-amber-900/40 border-2 border-amber-500/70 rounded-xl text-center" data-testid="rental-card-banner">
              <div className="text-3xl mb-1">🏷️</div>
              <div className="text-amber-300 font-bold text-xl">{t("returnRentalCard")}</div>
              <div className="text-amber-400/80 text-sm mt-1">{t("returnRentalCardHint")}</div>
            </div>
          )}

          {/* Missing controls banner */}
          {readout.data?.found && readout.data.missingControls.length > 0 && (
            <div className="mb-3 p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-left">
              <div className="text-red-400 font-semibold mb-2">
                {t("missingControls", { count: readout.data.missingControls.length })}
              </div>
              <div className="flex flex-wrap gap-2">
                {readout.data.missingControls.map((code, i) => (
                  <span key={i} className="px-3 py-1 bg-red-800/50 text-red-300 rounded-lg font-mono text-lg">
                    {code}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Non-OK position summary (Bad / Optional / NoTiming / BadNoTiming).
              Compact pills so a runner who passed through a transit zone or
              a broken control can see the kiosk acknowledged it. We don't
              show plain "ok" required positions here — the X/Y stat already
              covers those. */}
          {readout.data?.found && (() => {
            const specials = readout.data.controls.filter(
              (c) => c.positionMode !== "required",
            );
            if (specials.length === 0) return null;
            return (
              <div className="mb-3 p-3 bg-slate-800/60 border border-slate-700/60 rounded-xl text-left">
                <div className="text-slate-300 font-semibold mb-2">
                  {t("specialControls")}
                </div>
                <div className="flex flex-wrap gap-2">
                  {specials.map((c, i) => {
                    const labelKey = c.positionMode === "noTiming"
                      ? "noTimingPill"
                      : c.status === "ok"
                      ? "skippedPunchedPill"
                      : "skippedMissingPill";
                    const palette =
                      c.positionMode === "noTiming"
                        ? "bg-blue-900/40 border-blue-700/50 text-blue-200"
                        : c.status === "ok"
                        ? "bg-amber-900/30 border-amber-700/40 text-amber-200"
                        : "bg-slate-900/40 border-slate-700/50 text-slate-300";
                    return (
                      <span
                        key={i}
                        className={`px-3 py-1 border rounded-lg text-sm font-mono tabular-nums ${palette}`}
                      >
                        {t(labelKey, { code: c.controlCode })}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Summary stats */}
          {readout.data?.found && (
            <div className="bg-slate-800 rounded-2xl p-3 mb-3">
              <div className={`grid gap-3 text-center ${readout.data.course ? "grid-cols-3" : ""}`}>
                <div>
                  <div className="text-sm text-slate-400">{t("controls")}</div>
                  <div className="text-2xl font-bold">
                    {/* Numerator: punched required positions. Denominator:
                        required positions only — skipped (Bad / Optional /
                        BadNoTiming) controls were never expected to be
                        punched, so counting them would understate the
                        runner's score. NoTiming counts as required since
                        the punch is still mandatory; only the leg time
                        is excluded. */}
                    {
                      readout.data.controls.filter(
                        (c) => c.status === "ok" && c.positionMode !== "skipped",
                      ).length
                    }
                    /
                    {
                      readout.data.course?.requiredControlCount ??
                      readout.data.controls.filter((c) => c.positionMode !== "skipped").length
                    }
                  </div>
                </div>
                {readout.data.course && (
                  <>
                    <div>
                      <div className="text-sm text-slate-400">{t("course")}</div>
                      <div className="text-2xl font-bold">{readout.data.course.name}</div>
                    </div>
                    <div>
                      <div className="text-sm text-slate-400">{t("length")}</div>
                      <div className="text-2xl font-bold">
                        {(readout.data.course.length / 1000).toFixed(1)} km
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Class results */}
          {receipt.data?.classResults && receipt.data.classResults.length > 0 && (
            <div className="bg-slate-800 rounded-2xl p-4 text-left">
              <div className="text-sm text-slate-400 mb-2 font-semibold">{t("classResults")}</div>
              <div className="space-y-1">
                {receipt.data.classResults.map((r) => (
                  <div key={r.rank} className={`flex items-center gap-3 text-sm py-1 ${r.rank === receipt.data!.position?.rank ? "text-emerald-400 font-bold" : "text-slate-300"}`}>
                    <span className="w-6 text-right font-mono">{r.rank}.</span>
                    <span className="flex-1 truncate">{r.name}</span>
                    {r.clubName && <span className="text-slate-500 truncate max-w-[120px]">{r.clubName}</span>}
                    <span className="font-mono tabular-nums">{formatRunningTime(r.runningTime)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Shared status icon for readout screen */
function StatusIcon({ status }: { status: number }) {
  const isOK = status === RunnerStatus.OK;
  const isMP = status === RunnerStatus.MissingPunch;
  const isDNF = status === RunnerStatus.DNF;

  if (isOK) return (
    <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-emerald-500/20 border-4 border-emerald-400">
      <svg className="w-14 h-14 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </div>
  );
  if (isMP) return (
    <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-red-500/20 border-4 border-red-400">
      <svg className="w-14 h-14 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </div>
  );
  if (isDNF) return (
    <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-amber-500/20 border-4 border-amber-400">
      <svg className="w-14 h-14 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
    </div>
  );
  return (
    <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-blue-500/20 border-4 border-blue-400">
      <svg className="w-14 h-14 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
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
  const { t } = useTranslation("kiosk");
  // Fetch runner details for start time and course
  const lookup = trpc.race.lookupByCard.useQuery(
    { cardNo: card.cardNumber },
    { enabled: card.cardNumber > 0 },
  );

  // Event clock for the countdown (ticks locally, event time zone).
  const clock = useEventClock();

  const runner = lookup.data?.found ? lookup.data.runner : null;
  const course = lookup.data?.found ? lookup.data.course : null;
  const currentTimeDeci = clock.currentDs;

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
          {clearCheckOk ? t("readyToStart") : t("cardNotReady")}
        </div>
      </div>

      {/* Runner info */}
      <h1 className="text-5xl font-black mb-2">
        {runner?.name || card.runnerName || t("cardNumber", { number: card.cardNumber })}
      </h1>
      {(runner?.clubName || card.clubName) && (
        <p className="text-2xl text-slate-400 mb-1 flex items-center justify-center gap-2">
          {runner?.clubId ? <ClubLogo clubId={runner.clubId} size="md" /> : null}
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
            {t("cardNeedsPrep")}
          </div>
          <div className="space-y-1 text-red-300">
            {!hasClear && <p>{t("cardNotCleared")}</p>}
            {!hasCheck && <p>{t("cardNotChecked")}</p>}
          </div>
          <p className="text-red-400/70 mt-2 text-sm">
            {t("clearCheckHint")}
          </p>
        </div>
      )}

      {/* Course info */}
      {course && (
        <div className="bg-slate-800 rounded-2xl p-6 mb-6 max-w-md mx-auto">
          <div className="grid grid-cols-2 gap-4 text-center">
            <div>
              <div className="text-sm text-slate-400">{t("course")}</div>
              <div className="text-xl font-bold">{course.name}</div>
            </div>
            <div>
              <div className="text-sm text-slate-400">{t("length")}</div>
              <div className="text-xl font-bold">
                {(course.length / 1000).toFixed(1)} km
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Start time with countdown */}
      {runner?.startTime != null && runner.startTime > 0 ? (
        <div className="mt-6">
          <div className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2">
            {t("startTime")}
          </div>
          <div className="text-7xl font-black tabular-nums text-emerald-400">
            {formatMeosTime(runner.startTime)}
          </div>
          {timeToStart !== 0 && (
            <div className={`mt-3 text-2xl font-semibold tabular-nums ${isPast ? "text-amber-400" : "text-emerald-300"
              }`}>
              {isPast ? `${t("started")} ` : ""}
              {countdownMinutes > 0 && `${countdownMinutes}m `}
              {countdownSeconds}s
              {isPast ? ` ${t("ago")}` : ` ${t("toStart")}`}
            </div>
          )}
        </div>
      ) : runner?.classFreeStart ? (
        <div className="mt-6">
          <div className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2">
            {t("startTime")}
          </div>
          <div className="text-3xl font-bold text-emerald-400">
            {t("freeStart")}
          </div>
        </div>
      ) : (
        <div className="mt-6">
          <div className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2">
            {t("startTime")}
          </div>
          <div className="text-3xl font-bold text-slate-500">
            {t("notAssigned")}
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
  onRequestReceipt,
}: {
  card: KioskCardReadoutMessage["card"];
  form?: RegistrationFormState;
  onRequestReceipt: (printReceipt: boolean) => void;
}) {
  const { t } = useTranslation("kiosk");
  // The admin tab only includes `printReceipt` in form-state when the
  // organizer has enabled registration-receipt printing. Treat its presence
  // as the signal that the receipt option is available to runners at all.
  const receiptOptionAvailable = form?.printReceipt !== undefined;
  const receiptRequested = form?.printReceipt === true;
  return (
    <div className="text-center max-w-lg mx-auto">
      <div className="mb-8">
        <div className="inline-block w-16 h-16 border-4 border-emerald-300 border-t-transparent rounded-full animate-spin" />
      </div>
      <h1 className="text-4xl font-bold text-white mb-4">
        {t("registrationInProgress")}
      </h1>
      <p className="text-xl text-slate-400 mb-6">
        {t("pleaseWait")}
      </p>

      <div className="bg-slate-800 rounded-2xl p-6 text-left space-y-3">
        <InfoRow label={t("cardLabel")} value={String(form?.cardNo || card.cardNumber)} />
        {(form?.name || card.ownerData?.firstName) && (
          <InfoRow label={t("nameLabel")} value={form?.name || [card.ownerData?.firstName, card.ownerData?.lastName].filter(Boolean).join(" ")} />
        )}
        {form?.clubName && (
          <div className="flex justify-between items-center py-1 border-b border-slate-700/50">
            <span className="text-slate-400 text-sm">{t("clubLabel")}</span>
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
        {form?.className && <InfoRow label={t("classLabel")} value={form.className} />}
        {form?.paymentMode && (
          <InfoRow
            label={t("paymentLabel")}
            value={form.paymentMode === "billed" ? t("invoice") : form.paymentMode === "swish" ? t("swish") : form.paymentMode === "card" ? t("cardPayment") : form.paymentMode === "cash" ? t("cash") : t("payOnSite")}
          />
        )}
        {form?.fee != null && form.fee > 0 && form.paymentMode && form.paymentMode !== "billed" && (
          <InfoRow label={t("amountLabel")} value={`${form.fee} kr`} />
        )}
        {form?.isRentalCard && form.cardFee != null && form.cardFee !== 0 && (
          <InfoRow label="🏷️" value={t("rentalCardFee", { fee: form.cardFee })} />
        )}
      </div>

      {/* Receipt opt-in — only shown when the organizer has enabled
          registration-receipt printing for this competition. */}
      {receiptOptionAvailable && (
        <div className="mt-4 flex items-center justify-between gap-3 bg-slate-800 rounded-2xl px-5 py-3">
          <div className="text-left">
            <div className="text-sm uppercase tracking-wider text-slate-400">
              {t("receiptLabel")}
            </div>
            <div className="text-base font-medium text-white">
              {receiptRequested ? t("receiptWillBePrinted") : t("receiptDeclined")}
            </div>
          </div>
          <button
            type="button"
            data-testid="kiosk-receipt-request"
            onClick={() => onRequestReceipt(!receiptRequested)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              receiptRequested
                ? "bg-slate-700 hover:bg-slate-600 text-slate-200"
                : "bg-emerald-500 hover:bg-emerald-400 text-slate-900"
            }`}
          >
            {receiptRequested ? t("declineReceipt") : t("requestReceipt")}
          </button>
        </div>
      )}

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
          <p className="text-slate-400 text-sm mt-3">{t("scanSwish", { amount: form.fee })}</p>
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
  const { t } = useTranslation("kiosk");
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
        {t("registrationComplete")}
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
          {t("start")}
        </div>
        {runner.startTime ? (
          <div className="text-5xl font-black tabular-nums text-emerald-400">
            {runner.startTime}
          </div>
        ) : (
          <div className="text-3xl font-bold text-emerald-400">
            {t("freeStart")}
          </div>
        )}
      </div>

      <p className="text-slate-500 mt-6 text-sm">
        {t("proceedToStart")}
      </p>
    </div>
  );
}
