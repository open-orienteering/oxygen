import { Routes, Route, Navigate } from "react-router-dom";
import { CompetitionSelector } from "./pages/CompetitionSelector";
import { CompetitionShell } from "./pages/CompetitionShell";
import { KioskPage } from "./pages/KioskPage";
import { StartScreenPage } from "./pages/StartScreenPage";
import { useVersionCheck } from "./hooks/useVersionCheck";
import { DeviceManagerProvider } from "./context/DeviceManager";

export default function App() {
  const { updateAvailable, reload } = useVersionCheck();

  return (
    <DeviceManagerProvider>
      {updateAvailable && (
        <div className="fixed top-0 left-0 right-0 z-[9999] bg-blue-600 text-white text-center py-1.5 px-4 text-sm shadow-lg flex items-center justify-center gap-3">
          <span>A new version is available.</span>
          <button
            onClick={reload}
            className="bg-white text-blue-600 px-3 py-0.5 rounded font-medium hover:bg-blue-50 transition-colors cursor-pointer"
          >
            Reload
          </button>
        </div>
      )}
      <Routes>
        <Route path="/" element={<CompetitionSelector />} />
        {/* Kiosk route — outside CompetitionShell (fullscreen, no admin UI) */}
        <Route path="/:nameId/kiosk" element={<KioskPage />} />
        <Route path="/:nameId/start-screen" element={<StartScreenPage />} />
        <Route path="/:nameId/*" element={<CompetitionShell />} />
        {/* Catch-all redirect to home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DeviceManagerProvider>
  );
}
