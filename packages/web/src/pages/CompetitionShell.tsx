import { useEffect, useState, useCallback } from "react";
import {
  useParams,
  useNavigate,
  useLocation,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { trpc } from "../lib/trpc";
import { CompetitionDashboard } from "./CompetitionDashboard";
import { RunnerManagement } from "./RunnerManagement";
import { StartListPage } from "./StartListPage";
import { ResultsPage } from "./ResultsPage";
import { StartStation } from "./StartStation";
import { CardReadout } from "./CardReadout";
import { ControlsPage } from "./ControlsPage";
import { CoursesPage } from "./CoursesPage";
import { ClassesPage } from "./ClassesPage";
import { ClubsPage } from "./ClubsPage";
import { CardsPage } from "./CardsPage";
import { EventPage } from "./EventPage";
import { TestLabPage } from "./TestLabPage";
import { ClubLogo } from "../components/ClubLogo";
import { useDeviceManager } from "../context/DeviceManager";
import { CardNotification } from "../components/CardNotification";
import { RecentCards } from "../components/RecentCards";
import { DbLoadIndicator } from "../components/DbLoadIndicator";
import { useExternalChanges } from "../hooks/useExternalChanges";

type Tab = "dashboard" | "event" | "runners" | "startlist" | "results" | "classes" | "courses" | "controls" | "clubs" | "start-station" | "card-readout" | "cards" | "test-lab";

const tabs: { id: Tab; path: string; label: string; group?: string; countKey?: string; isOverflow?: boolean }[] = [
  { id: "dashboard", path: "", label: "Dashboard" },
  { id: "runners", path: "runners", label: "Runners", countKey: "runners" },
  { id: "startlist", path: "startlist", label: "Start List", countKey: "startlist" },
  { id: "results", path: "results", label: "Results", countKey: "results" },
  { id: "classes", path: "classes", label: "Classes", countKey: "classes" },
  { id: "courses", path: "courses", label: "Courses", countKey: "courses" },
  { id: "controls", path: "controls", label: "Controls", countKey: "controls" },
  { id: "cards", path: "cards", label: "Cards", countKey: "cards" }, // Primary now
  // Overflow items
  { id: "event", path: "event", label: "Event", isOverflow: true },
  { id: "clubs", path: "clubs", label: "Clubs", countKey: "clubs", isOverflow: true },
  { id: "start-station", path: "start-station", label: "Start Station", group: "race", isOverflow: true },
  { id: "card-readout", path: "card-readout", label: "Card Readout", group: "race", isOverflow: true },
  { id: "test-lab", path: "test-lab", label: "Test Lab", group: "dev", isOverflow: true },
];

export function CompetitionShell() {
  const { nameId } = useParams<{ nameId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

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
  const { setCompetitionNameId } = useDeviceManager();
  const selectMutation = trpc.competition.select.useMutation({
    onSuccess: (data) => {
      setCompetitionName(data.name);
      setReady(true);
    },
  });

  // Fetch dashboard data for counts and organizer logo
  const dashboard = trpc.competition.dashboard.useQuery(undefined, {
    enabled: ready,
    staleTime: 30_000,
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
      utils.invalidate().then(() => {
        selectMutation.mutate({ nameId });
      });
    }
    return () => setCompetitionNameId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameId]);

  const handleTabChange = (tab: Tab) => {
    const tabDef = tabs.find((t) => t.id === tab);
    const path = tabDef?.path ? `/${nameId}/${tabDef.path}` : `/${nameId}`;
    navigate(path);
  };

  if (selectMutation.isError) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-red-500 text-lg font-medium mb-2">
            Competition not found
          </div>
          <p className="text-slate-500 text-sm mb-4">
            Could not connect to competition &ldquo;{nameId}&rdquo;.
          </p>
          <button
            onClick={() => navigate("/")}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
          >
            Back to competitions
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
          <p className="text-slate-500 mt-4">Loading competition...</p>
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
                title="Back to competition list"
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
              <KioskLauncher nameId={nameId ?? ""} />
              <StartScreenLauncher nameId={nameId ?? ""} />
              <DbLoadIndicator enabled={ready} />
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                Connected
              </span>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center justify-between border-b border-slate-200">
            <nav className="-mb-px flex flex-1 gap-1 overflow-x-auto min-w-0" aria-label="Tabs" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
              {tabs.filter((t) => !t.isOverflow).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${activeTab === tab.id
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                    }`}
                >
                  {tab.label}
                  {tab.countKey && counts[tab.countKey] > 0 && (
                    <span aria-hidden="true" className={`ml-1 text-xs ${activeTab === tab.id ? "text-blue-400" : "text-slate-400"
                      }`}>
                      {counts[tab.countKey]}
                    </span>
                  )}
                </button>
              ))}
            </nav>

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
                  More
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
                      {tabs.filter((t) => t.isOverflow).map((tab) => (
                        <button
                          key={tab.id}
                          onClick={() => {
                            handleTabChange(tab.id);
                            setShowMoreMenu(false);
                          }}
                          className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer flex items-center justify-between ${activeTab === tab.id
                            ? "bg-blue-50 text-blue-700 font-semibold"
                            : "text-slate-700 hover:bg-slate-50"
                            }`}
                        >
                          <span className="flex items-center gap-2">
                            {tab.group === "race" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                            {tab.group === "dev" && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                            {tab.label}
                          </span>
                          {tab.countKey && counts[tab.countKey] > 0 && (
                            <span className="text-xs text-slate-400">
                              {counts[tab.countKey]}
                            </span>
                          )}
                        </button>
                      ))}
                      <div className="my-1 border-t border-slate-100" />
                      <div className="px-2 py-1">
                        <StartScreenLauncher nameId={nameId ?? ""} onLaunch={() => setShowMoreMenu(false)} />
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
      <CardNotification />

      {/* Tab Content via nested routes */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
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
          <Route path="card-readout" element={<CardReadout />} />
          <Route path="test-lab" element={<TestLabPage />} />
          <Route path="*" element={<Navigate to="" replace />} />
        </Routes>
      </main>

      {/* Floating recent cards panel */}
      <RecentCards />
    </div>
  );
}

// ─── Kiosk Launcher ─────────────────────────────────────────

function KioskLauncher({ nameId }: { nameId: string }) {
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
      title={connected ? "Kiosk connected — click to open another window" : "Open kiosk display in a new window"}
      data-testid="kiosk-launcher"
    >
      {connected && (
        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
      )}
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
      Kiosk
    </button>
  );
}

// ─── Start Screen Launcher ──────────────────────────────────

function StartScreenLauncher({ nameId, onLaunch }: { nameId: string; onLaunch?: () => void }) {
  const handleLaunch = useCallback(() => {
    const url = `/${nameId}/start-screen`;
    window.open(url, "oxygen-start-screen", "popup");
    onLaunch?.();
  }, [nameId, onLaunch]);

  return (
    <button
      onClick={handleLaunch}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
      title="Open start screen display in a new window"
      data-testid="start-screen-launcher"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      Start
    </button>
  );
}

// ─── Reader Status Indicator ────────────────────────────────

function ReaderStatusIndicator() {
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
        title="Connect SI Reader"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        Connect Reader
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
        SI Reader
      </button>
      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setShowMenu(false)}
          />
          <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-3 min-w-[180px]">
            <div className="text-xs text-slate-500 mb-2">
              Status: {readerStatus === "reading" ? "Active" : "Connected"}
            </div>
            <button
              onClick={() => {
                disconnectReader();
                setShowMenu(false);
              }}
              className="w-full text-left text-sm text-red-600 hover:bg-red-50 px-2 py-1.5 rounded transition-colors cursor-pointer"
              data-testid="disconnect-reader"
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}
