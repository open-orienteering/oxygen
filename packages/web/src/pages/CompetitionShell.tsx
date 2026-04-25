import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react";
import {
  useParams,
  useNavigate,
  useLocation,
  Routes,
  Route,
  Navigate,
  Link,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { ClubLogo } from "../components/ClubLogo";
import { LanguageSelector } from "../components/LanguageSelector";
import { useDeviceManager } from "../context/DeviceManager";
import { usePrinter } from "../context/PrinterContext";
import { fetchLogoRaster } from "../lib/receipt-printer/index.js";
import { getClubLogoUrl } from "../lib/club-logo";
import { CardNotification } from "../components/CardNotification";
import { RecentCards } from "../components/RecentCards";
import { RegistrationDialogProvider } from "../context/RegistrationDialogContext";
import { RegistrationDialog } from "../components/RegistrationDialog";
import { DbLoadIndicator } from "../components/DbLoadIndicator";
import { useExternalChanges } from "../hooks/useExternalChanges";
import { SyncStatusIndicator } from "../components/SyncStatusIndicator";

// Lazy-loaded page components — each becomes a separate chunk
const CompetitionDashboard = lazy(() => import("./CompetitionDashboard").then(m => ({ default: m.CompetitionDashboard })));
const RunnerManagement = lazy(() => import("./RunnerManagement").then(m => ({ default: m.RunnerManagement })));
const StartListPage = lazy(() => import("./StartListPage").then(m => ({ default: m.StartListPage })));
const ResultsPage = lazy(() => import("./ResultsPage").then(m => ({ default: m.ResultsPage })));
const StartStation = lazy(() => import("./StartStation").then(m => ({ default: m.StartStation })));
const FinishStation = lazy(() => import("./FinishStation").then(m => ({ default: m.FinishStation })));
const CardReadout = lazy(() => import("./CardReadout").then(m => ({ default: m.CardReadout })));
const ControlsPage = lazy(() => import("./ControlsPage").then(m => ({ default: m.ControlsPage })));
const CoursesPage = lazy(() => import("./CoursesPage").then(m => ({ default: m.CoursesPage })));
const ClassesPage = lazy(() => import("./ClassesPage").then(m => ({ default: m.ClassesPage })));
const ClubsPage = lazy(() => import("./ClubsPage").then(m => ({ default: m.ClubsPage })));
const CardsPage = lazy(() => import("./CardsPage").then(m => ({ default: m.CardsPage })));
const EventPage = lazy(() => import("./EventPage").then(m => ({ default: m.EventPage })));
const TestLabPage = lazy(() => import("./TestLabPage").then(m => ({ default: m.TestLabPage })));
const BackupPunchesPage = lazy(() => import("./BackupPunchesPage").then(m => ({ default: m.BackupPunchesPage })));
const TracksPage = lazy(() => import("./TracksPage").then(m => ({ default: m.TracksPage })));
const TracksReplayPage = lazy(() => import("./TracksReplayPage").then(m => ({ default: m.TracksReplayPage })));

type Tab = "dashboard" | "event" | "runners" | "startlist" | "results" | "classes" | "courses" | "controls" | "clubs" | "start-station" | "finish-station" | "card-readout" | "cards" | "backup-punches" | "test-lab" | "tracks";

const tabLabelKeys = {
  "dashboard": "dashboard",
  "runners": "runners",
  "startlist": "startList",
  "results": "results",
  "classes": "classes",
  "courses": "courses",
  "controls": "controls",
  "cards": "cards",
  "event": "event",
  "clubs": "clubs",
  "start-station": "startStation",
  "finish-station": "finishStation",
  "card-readout": "cardReadout",
  "backup-punches": "backupPunches",
  "test-lab": "testLab",
  "tracks": "tracks",
} as const satisfies Record<Tab, string>;

const tabs: { id: Tab; path: string; group?: string; countKey?: string; isOverflow?: boolean }[] = [
  { id: "dashboard", path: "" },
  { id: "runners", path: "runners", countKey: "runners" },
  { id: "startlist", path: "startlist", countKey: "startlist" },
  { id: "results", path: "results", countKey: "results" },
  { id: "classes", path: "classes", countKey: "classes" },
  { id: "courses", path: "courses", countKey: "courses" },
  { id: "controls", path: "controls", countKey: "controls" },
  { id: "cards", path: "cards", countKey: "cards" },
  { id: "tracks", path: "tracks" },
  // Overflow items
  { id: "event", path: "event", isOverflow: true },
  { id: "clubs", path: "clubs", countKey: "clubs", isOverflow: true },
  { id: "start-station", path: "start-station", group: "race", isOverflow: true },
  { id: "finish-station", path: "finish-station", group: "race", isOverflow: true },
  { id: "card-readout", path: "card-readout", group: "race", isOverflow: true },
  { id: "backup-punches", path: "backup-punches", group: "race", isOverflow: true },
  { id: "test-lab", path: "test-lab", group: "dev", isOverflow: true },
];

export function CompetitionShell() {
  const { nameId } = useParams<{ nameId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation("nav");

  // Determine active tab from current URL path
  const pathAfterNameId = location.pathname.split(`/${nameId}/`)[1] ?? "";
  const firstSegment = pathAfterNameId.split("/")[0] || "";
  const activeTab: Tab =
    tabs.find((t) => t.path === firstSegment)?.id ?? "dashboard";

  // Auto-select the competition on mount / nameId change
  const [competitionName, setCompetitionName] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  // Poll oCounter for external changes (e.g. from MeOS) and auto-invalidate caches
  useExternalChanges(ready);
  const utils = trpc.useUtils();
  const { setCompetitionNameId, getKioskChannel } = useDeviceManager();
  const { print: printerPrint } = usePrinter();
  const selectMutation = trpc.competition.select.useMutation({
    onSuccess: (data) => {
      setCompetitionName(data.name);
      setReady(true);
    },
    onError: () => {
      // Offline fallback: use cached dashboard data to get competition name
      if (!navigator.onLine) {
        const cachedDashboard = utils.competition.dashboard.getData();
        if (cachedDashboard?.competition?.name) {
          setCompetitionName(cachedDashboard.competition.name);
          setReady(true);
        }
      }
    },
  });

  // Fetch dashboard data for counts and organizer logo
  const dashboard = trpc.competition.dashboard.useQuery(undefined, {
    enabled: ready,
    staleTime: 30_000,
  });
  const regConfig = trpc.competition.getRegistrationConfig.useQuery(undefined, {
    enabled: ready,
    staleTime: 60_000,
  });

  const counts: Record<string, number> = {
    runners: dashboard.data?.totalRunners ?? 0,
    clubs: dashboard.data?.totalClubs ?? 0,
    classes: dashboard.data?.classes.length ?? 0,
    courses: dashboard.data?.totalCourses ?? 0,
    controls: dashboard.data?.totalControls ?? 0,
    startlist: dashboard.data?.statusCounts?.startListCount ?? 0,
    results: dashboard.data?.statusCounts?.resultCount ?? 0,
  };

  const organizerEventorId = dashboard.data?.organizer?.eventorId;

  useEffect(() => {
    if (nameId) {
      setReady(false);
      setCompetitionNameId(nameId);
      if (navigator.onLine) {
        utils.invalidate().then(() => {
          selectMutation.mutate({ nameId });
        });
      } else {
        // Offline: skip cache invalidation (we need that data!) and try select
        // (will fail and trigger onError fallback to cached data)
        selectMutation.mutate({ nameId });
      }
    }
    return () => setCompetitionNameId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameId]);

  // Forward kiosk print requests to the local printer.
  // The kiosk only sends a runnerId; the admin shell fetches the full receipt
  // data itself (logo, QR, custom message) so the receipt is always complete.
  const dashboardRef = useRef(dashboard.data);
  const regConfigRef = useRef(regConfig.data);
  useEffect(() => { dashboardRef.current = dashboard.data; }, [dashboard.data]);
  useEffect(() => { regConfigRef.current = regConfig.data; }, [regConfig.data]);

  useEffect(() => {
    const channel = getKioskChannel();
    if (!channel) return;
    return channel.subscribe((msg) => {
      if (msg.type !== "kiosk-print-receipt") return;
      const { runnerId } = msg;
      const competitionInfo = dashboardRef.current?.competition;
      const eventorId = dashboardRef.current?.organizer?.eventorId;
      const finishMsg = regConfigRef.current?.finishReceiptMessage;
      utils.race.finishReceipt.fetch({ runnerId }).then(async (result) => {
        if (!result) return;
        const logoRaster = eventorId
          ? await fetchLogoRaster(getClubLogoUrl(eventorId), 250).catch(() => null)
          : null;
        return printerPrint({
          competitionName: competitionInfo?.name ?? "",
          competitionDate: competitionInfo?.date ?? undefined,
          runner: {
            name: result.runner.name,
            clubName: result.runner.clubName,
            className: result.runner.className,
            startNo: result.runner.startNo,
            cardNo: result.runner.cardNo,
          },
          timing: result.timing,
          splits: result.controls.map((c) => ({
            controlIndex: c.controlIndex,
            controlCode: c.controlCode,
            splitTime: c.splitTime,
            cumTime: c.cumTime,
            status: c.status,
            punchTime: c.punchTime,
            legLength: c.legLength,
          })),
          course: result.course ? { name: result.course.name, length: result.course.length } : null,
          position: result.position,
          siac: result.siac,
          classResults: result.classResults,
          logoRaster,
          qrUrl: competitionInfo?.eventorEventId
            ? `https://eventor.orientering.se/Events/Show/${competitionInfo.eventorEventId}`
            : "https://open-orienteering.org",
          customMessage: finishMsg || undefined,
        });
      }).catch(() => {});
    });
  }, [getKioskChannel, printerPrint, utils]);

  const handleTabChange = (tab: Tab) => {
    const tabDef = tabs.find((t) => t.id === tab);
    const path = tabDef?.path ? `/${nameId}/${tabDef.path}` : `/${nameId}`;
    navigate(path);
  };

  if (selectMutation.isError && !ready) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-red-500 text-lg font-medium mb-2">
            {t("competitionNotFound")}
          </div>
          <p className="text-slate-500 text-sm mb-4">
            {t("couldNotConnect", { nameId })}
          </p>
          <button
            onClick={() => navigate("/")}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
          >
            {t("backToCompetitionList")}
          </button>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          <p className="text-slate-500 mt-4">{t("loadingCompetition")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate("/")}
                className="p-2 -ml-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                title={t("backToCompetitions")}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              {organizerEventorId && organizerEventorId > 0 && (
                <ClubLogo
                  eventorId={organizerEventorId}
                  size="md"
                  className="rounded"
                />
              )}
              <h1 className="text-lg font-semibold text-slate-900 leading-tight">
                {competitionName}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <ReaderStatusIndicator />
              <PrinterStatusIndicator />
              <KioskLauncher nameId={nameId ?? ""} />
              <StartScreenLauncher nameId={nameId ?? ""} />
              <DbLoadIndicator enabled={ready} />
              <SyncStatusIndicator competitionId={nameId} />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center justify-between border-b border-slate-200">
            <nav className="-mb-px flex flex-1 gap-1 overflow-x-auto min-w-0" aria-label="Tabs" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
              {tabs.filter((t) => !t.isOverflow).map((tab) => {
                const path = tab.path ? `/${nameId}/${tab.path}` : `/${nameId}`;
                return (
                  <Link
                    key={tab.id}
                    to={path}
                    className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${activeTab === tab.id
                      ? "border-blue-600 text-blue-600"
                      : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                      }`}
                  >
                    {t(tabLabelKeys[tab.id])}
                    {tab.countKey && counts[tab.countKey] > 0 && (
                      <span aria-hidden="true" className={`ml-1 text-xs ${activeTab === tab.id ? "text-blue-400" : "text-slate-400"
                        }`}>
                        {counts[tab.countKey]}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>

            {/* Active overflow tab — promoted into the top bar so the user can see
                what page they're on. Disappears as soon as activeTab is no longer overflow. */}
            {(() => {
              const activeOverflow = tabs.find((tt) => tt.id === activeTab && tt.isOverflow);
              if (!activeOverflow) return null;
              const path = activeOverflow.path
                ? `/${nameId}/${activeOverflow.path}`
                : `/${nameId}`;
              return (
                <div className="flex-shrink-0 -mb-px">
                  <Link
                    to={path}
                    data-testid={`active-overflow-tab-${activeOverflow.id}`}
                    className="px-3 py-2.5 text-sm font-medium border-b-2 border-blue-600 text-blue-600 whitespace-nowrap inline-flex items-center"
                  >
                    {t(tabLabelKeys[activeOverflow.id])}
                    {activeOverflow.countKey && counts[activeOverflow.countKey] > 0 && (
                      <span aria-hidden="true" className="ml-1 text-xs text-blue-400">
                        {counts[activeOverflow.countKey]}
                      </span>
                    )}
                  </Link>
                </div>
              );
            })()}

            {/* More Menu Dropdown - Outside scrollable area to prevent clipping */}
            <div className="flex-shrink-0 border-l border-slate-200 ml-2">
              <div className="relative -mb-px">
                <button
                  onClick={() => setShowMoreMenu(!showMoreMenu)}
                  data-testid="more-menu-button"
                  className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1 leading-none ${tabs.find(t => t.id === activeTab)?.isOverflow
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                    }`}
                >
                  {t("more")}
                  <svg className={`w-4 h-4 transition-transform ${showMoreMenu ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showMoreMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setShowMoreMenu(false)}
                    />
                    <div
                      data-testid="more-menu-content"
                      className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[200px]"
                    >
                      {tabs.filter((t) => t.isOverflow).map((tab) => {
                        const path = tab.path ? `/${nameId}/${tab.path}` : `/${nameId}`;
                        return (
                          <Link
                            key={tab.id}
                            to={path}
                            onClick={() => setShowMoreMenu(false)}
                            className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer flex items-center justify-between ${activeTab === tab.id
                              ? "bg-blue-50 text-blue-700 font-semibold"
                              : "text-slate-700 hover:bg-slate-50"
                              }`}
                          >
                            <span className="flex items-center gap-2">
                              {tab.group === "race" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                              {tab.group === "dev" && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                              {t(tabLabelKeys[tab.id])}
                            </span>
                            {tab.countKey && counts[tab.countKey] > 0 && (
                              <span className="text-xs text-slate-400">
                                {counts[tab.countKey]}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                      <div className="my-1 border-t border-slate-100" />
                      <div className="px-2 py-1">
                        <StartScreenLauncher nameId={nameId ?? ""} onLaunch={() => setShowMoreMenu(false)} />
                      </div>
                      <div className="my-1 border-t border-slate-100" />
                      <div className="px-4 py-1.5">
                        <LanguageSelector />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Global card notification banner */}
      <RegistrationDialogProvider>
        <CardNotification />

        {/* Tab Content via nested routes */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <Suspense fallback={<div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" /></div>}>
          <Routes>
            <Route index element={<CompetitionDashboard />} />
            <Route path="event" element={<EventPage />} />
            <Route path="runners" element={<RunnerManagement />} />
            <Route path="startlist" element={<StartListPage />} />
            <Route path="results" element={<ResultsPage />} />
            <Route path="classes" element={<ClassesPage />} />
            <Route path="courses" element={<CoursesPage />} />
            <Route path="controls" element={<ControlsPage />} />
            <Route path="clubs" element={<ClubsPage />} />
            <Route path="cards" element={<CardsPage />} />
            <Route path="start-station" element={<StartStation />} />
            <Route path="finish-station" element={<FinishStation />} />
            <Route path="card-readout" element={<CardReadout />} />
            <Route path="registration" element={<Navigate to="" replace />} />
            <Route path="backup-punches" element={<BackupPunchesPage />} />
            <Route path="test-lab" element={<TestLabPage />} />
            <Route path="tracks" element={<TracksPage />} />
            <Route path="tracks/replay" element={<TracksReplayPage />} />
            <Route path="*" element={<Navigate to="" replace />} />
          </Routes>
          </Suspense>
        </main>

        {/* Floating recent cards panel */}
        <RecentCards />

        {/* Global registration dialog */}
        <RegistrationDialog />
      </RegistrationDialogProvider>
    </div>
  );
}

// ─── Kiosk Launcher ─────────────────────────────────────────

function KioskLauncher({ nameId }: { nameId: string }) {
  const { t } = useTranslation("nav");
  const { getKioskChannel } = useDeviceManager();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const checkConnection = async () => {
      const channel = getKioskChannel();
      if (!channel) {
        setConnected(false);
        return;
      }
      const alive = await channel.ping("admin", 1500);
      if (!cancelled) setConnected(alive);
    };

    checkConnection();
    const interval = setInterval(checkConnection, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [getKioskChannel]);

  const handleLaunch = useCallback(() => {
    const url = `/${nameId}/kiosk`;
    window.open(url, "oxygen-kiosk", "popup");
  }, [nameId]);

  return (
    <button
      onClick={handleLaunch}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer ${connected
        ? "text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
        : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
        }`}
      title={connected ? t("kioskConnectedTitle") : t("openKioskTitle")}
      data-testid="kiosk-launcher"
    >
      {connected && (
        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
      )}
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
      {t("kiosk")}
    </button>
  );
}

// ─── Start Screen Launcher ──────────────────────────────────

function StartScreenLauncher({ nameId, onLaunch }: { nameId: string; onLaunch?: () => void }) {
  const { t } = useTranslation("nav");
  const handleLaunch = useCallback(() => {
    const url = `/${nameId}/start-screen`;
    window.open(url, "oxygen-start-screen", "popup");
    onLaunch?.();
  }, [nameId, onLaunch]);

  return (
    <button
      onClick={handleLaunch}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
      title={t("openStartScreenTitle")}
      data-testid="start-screen-launcher"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {t("startScreen")}
    </button>
  );
}

// ─── Printer Status Indicator ───────────────────────────────

function PrinterStatusIndicator() {
  const { t } = useTranslation("nav");
  const { supported, connected, connect, disconnect } = usePrinter();
  const [showMenu, setShowMenu] = useState(false);

  if (!supported) return null;

  if (!connected) {
    return (
      <button
        onClick={() => connect().catch(() => {})}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
        title={t("connectPrinterTitle")}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
        </svg>
        {t("connectPrinter")}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-full transition-colors cursor-pointer"
        title={t("printerConnectedTitle")}
      >
        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
        {t("printer")}
      </button>
      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setShowMenu(false)}
          />
          <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-3 min-w-[180px]">
            <div className="text-xs text-slate-500 mb-2">{t("receiptPrinterConnected")}</div>
            <button
              onClick={() => {
                disconnect();
                setShowMenu(false);
              }}
              className="w-full text-left text-sm text-red-600 hover:bg-red-50 px-2 py-1.5 rounded transition-colors cursor-pointer"
            >
              {t("disconnect", { ns: "common" })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Reader Status Indicator ────────────────────────────────

function ReaderStatusIndicator() {
  const { t } = useTranslation("nav");
  const { supported, readerStatus, connectReader, disconnectReader } =
    useDeviceManager();
  const [showMenu, setShowMenu] = useState(false);

  if (!supported) return null;

  const isActive = readerStatus === "connected" || readerStatus === "reading";

  if (!isActive) {
    return (
      <button
        onClick={() => connectReader().catch(() => { })}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
        data-testid="connect-reader"
        title={t("connectReaderTitle")}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        {t("connectReader")}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-full transition-colors cursor-pointer"
        data-testid="reader-status"
      >
        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
        {t("siReader")}
      </button>
      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setShowMenu(false)}
          />
          <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-3 min-w-[180px]">
            <div className="text-xs text-slate-500 mb-2">
              {t("status", { ns: "common" })}: {readerStatus === "reading" ? t("readerStatusActive") : t("readerStatusConnected")}
            </div>
            <button
              onClick={() => {
                disconnectReader();
                setShowMenu(false);
              }}
              className="w-full text-left text-sm text-red-600 hover:bg-red-50 px-2 py-1.5 rounded transition-colors cursor-pointer"
              data-testid="disconnect-reader"
            >
              {t("disconnect", { ns: "common" })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
