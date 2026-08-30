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
const UsersAdminPage = lazy(() => import("./pages/UsersAdminPage").then(m => ({ default: m.UsersAdminPage })));
const LibraryPage = lazy(() => import("./pages/LibraryPage").then(m => ({ default: m.LibraryPage })));

const PUBLIC_SURFACE = /^\/[^/]+\/(kiosk|start-screen)(\/|$)/;

function PageSpinner() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
    </div>
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
  const { user, authEnabled, isLoading } = useCurrentUser();
  const isPublicSurface = PUBLIC_SURFACE.test(location.pathname);

  let gated: ReactNode = null;
  if (authEnabled && !isPublicSurface) {
    if (isLoading) gated = <PageSpinner />;
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
      <ErrorBoundary>
        <Suspense fallback={<PageSpinner />}>
          {gated ?? (
          <Routes>
            <Route path="/" element={<CompetitionSelector />} />
            <Route path="/admin/users" element={<UsersAdminPage />} />
            <Route path="/library" element={<LibraryPage />} />
            {/* Kiosk route — outside CompetitionShell (fullscreen, no admin UI) */}
            <Route path="/:nameId/kiosk" element={<KioskPage />} />
            <Route path="/:nameId/start-screen" element={<StartScreenPage />} />
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
