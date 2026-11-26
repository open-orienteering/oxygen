import { lazy, Suspense, type ReactNode } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useVersionCheck } from "./hooks/useVersionCheck";
import { useServiceWorkerUpdate } from "./hooks/useServiceWorkerUpdate";
import { resolveUpdateAction } from "./lib/app-update";
import { DeviceManagerProvider } from "./context/DeviceManager";
import { PrinterProvider } from "./context/PrinterContext";
import { useCurrentUser } from "./context/CurrentUserContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./i18n/i18n";

const CompetitionSelector = lazy(() => import("./pages/CompetitionSelector").then(m => ({ default: m.CompetitionSelector })));
const CompetitionShell = lazy(() => import("./pages/CompetitionShell").then(m => ({ default: m.CompetitionShell })));
const KioskPage = lazy(() => import("./pages/KioskPage").then(m => ({ default: m.KioskPage })));
const StartScreenPage = lazy(() => import("./pages/StartScreenPage").then(m => ({ default: m.StartScreenPage })));
const AccessDeniedPage = lazy(() => import("./pages/AccessDeniedPage").then(m => ({ default: m.AccessDeniedPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(m => ({ default: m.SettingsPage })));
const ClubMapReviewPage = lazy(() => import("./pages/MapReviewPage").then(m => ({ default: m.ClubMapReviewPage })));
// Dev-only: WebGL2 map backend fixture page for the golden-image tests (docs/map-rendering.md §6.2).
const MapGlFixturePage = import.meta.env.DEV
  ? lazy(() => import("./pages/dev/MapGlFixturePage").then(m => ({ default: m.MapGlFixturePage })))
  : null;
const MapGlDocPage = import.meta.env.DEV
  ? lazy(() => import("./pages/dev/MapGlDocPage").then(m => ({ default: m.MapGlDocPage })))
  : null;
// Dev-only: the terrain mesh, camera and shading on a synthetic field (docs/map-rendering.md §5.6).
const MapTerrainPage = import.meta.env.DEV
  ? lazy(() => import("./pages/dev/MapTerrainPage").then(m => ({ default: m.MapTerrainPage })))
  : null;

const PUBLIC_SURFACE = /^\/[^/]+\/(kiosk|start-screen)(\/|$)/;

function PageSpinner() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
    </div>
  );
}

/** Kiosk and start screen are dark full-screen surfaces: their own boundary, reset per event (WEB-15). */
function DarkBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname.split("/")[1]} variant="screen" autoResetMs={30_000}>
      {children}
    </ErrorBoundary>
  );
}

export default function App() {
  const { updateAvailable: apiRestarted, reload } = useVersionCheck();
  const { bundleWaiting, activate } = useServiceWorkerUpdate();
  const { updateAvailable, action } = resolveUpdateAction({
    apiRestarted,
    bundleWaiting,
  });
  const { t } = useTranslation();
  const location = useLocation();
  const { user, authEnabled, isLoading, sessionState } = useCurrentUser();
  const isPublicSurface = PUBLIC_SURFACE.test(location.pathname);

  let gated: ReactNode = null;
  if (authEnabled && !isPublicSurface) {
    if (isLoading) {
      gated = sessionState === "expired" ? (
        // Expired and nothing known: the bounded auto reload may be spent.
        <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-4 p-4 text-center">
          <p className="text-slate-600 text-sm max-w-md">{t("sessionExpired")}</p>
          <button
            data-testid="session-expired-reload"
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
          >
            {t("reload")}
          </button>
        </div>
      ) : <PageSpinner />;
    }
    else if (user === null) gated = <AccessDeniedPage />;
  }

  return (
    <DeviceManagerProvider>
    <PrinterProvider>
      {updateAvailable && (
        <div className="fixed top-0 left-0 right-0 z-[9999] bg-blue-600 text-white text-center py-1.5 px-4 text-sm shadow-lg flex items-center justify-center gap-3">
          <span>{t("versionUpdate")}</span>
          <button
            onClick={action === "activate-service-worker" ? activate : reload}
            className="bg-white text-blue-600 px-3 py-0.5 rounded font-medium hover:bg-blue-50 transition-colors cursor-pointer"
          >
            {t("reload")}
          </button>
        </div>
      )}
      {sessionState === "expired" && !gated && !isPublicSurface && (
        // WEB-04: an expired sign-in never reloads a page in use by itself.
        <div
          data-testid="session-expired-banner"
          className="fixed bottom-0 left-0 right-0 z-[9999] bg-amber-500 text-white text-center py-1.5 px-4 text-sm shadow-lg flex items-center justify-center gap-3"
        >
          <span>{t("sessionExpired")}</span>
          <button
            data-testid="session-expired-reload"
            onClick={() => window.location.reload()}
            className="bg-white text-amber-700 px-3 py-0.5 rounded font-medium hover:bg-amber-50 transition-colors cursor-pointer"
          >
            {t("reload")}
          </button>
        </div>
      )}
      <ErrorBoundary>
        <Suspense fallback={<PageSpinner />}>
          {gated ?? (
          <Routes>
            <Route path="/" element={<CompetitionSelector />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Import review of a club map's document (docs/map-symbols.md §8.7). */}
            <Route path="/settings/map-review/:documentHash" element={<ClubMapReviewPage />} />
            {/* Former standalone pages, now settings tabs. */}
            <Route
              path="/library"
              element={<Navigate to="/settings" replace />}
            />
            <Route
              path="/admin/users"
              element={<Navigate to="/settings?tab=users" replace />}
            />
            {MapGlFixturePage && <Route path="/dev/map-gl" element={<MapGlFixturePage />} />}
            {MapGlDocPage && <Route path="/dev/map-gl-doc" element={<MapGlDocPage />} />}
            {MapTerrainPage && <Route path="/dev/map-terrain" element={<MapTerrainPage />} />}
            {/* Kiosk route — outside CompetitionShell (fullscreen, no admin UI) */}
            <Route path="/:nameId/kiosk" element={<DarkBoundary><KioskPage /></DarkBoundary>} />
            <Route path="/:nameId/start-screen" element={<DarkBoundary><StartScreenPage /></DarkBoundary>} />
            <Route path="/:nameId/*" element={<CompetitionShell />} />
            {/* Catch-all redirect to home */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          )}
        </Suspense>
      </ErrorBoundary>
    </PrinterProvider>
    </DeviceManagerProvider>
  );
}
