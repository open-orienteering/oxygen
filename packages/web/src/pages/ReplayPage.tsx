/**
 * Standalone replay page.
 *
 * Usage:
 *   /replay?classId=1125893           — load from Livelox by class ID
 *   /:nameId/replay?classId=1125893   — same, within a competition context
 *
 * The input form also accepts an Eventor event ID, which resolves the linked
 * Livelox event via the Eventor API and shows a class picker.
 */

import { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { ReplayViewer } from "../components/replay/ReplayViewer";

type InputMode = "livelox" | "eventor";

export function ReplayPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const classIdParam = searchParams.get("classId");
  const classId = classIdParam ? parseInt(classIdParam, 10) : null;

  const [mode, setMode] = useState<InputMode>("livelox");
  const [inputUrl, setInputUrl] = useState("");
  const [eventorId, setEventorId] = useState("");

  // Livelox URL → classId (existing flow)
  const handleLoadUrl = () => {
    const match = inputUrl.match(/classId=(\d+)/);
    if (match) {
      setSearchParams({ classId: match[1] });
      setInputUrl("");
    }
  };

  // Eventor event ID → resolve Livelox class list
  const parsedEventorId = useMemo(() => {
    const n = parseInt(eventorId, 10);
    return !isNaN(n) && n > 0 ? n : null;
  }, [eventorId]);

  const {
    data: liveloxEvent,
    isLoading: isResolvingEvent,
    error: resolveError,
    refetch: retryResolve,
  } = trpc.eventor.getLiveloxClasses.useQuery(
    { eventorEventId: parsedEventorId! },
    { enabled: parsedEventorId != null && mode === "eventor", retry: 1, staleTime: 5 * 60_000 },
  );

  // Load the selected class
  const { data, isLoading, error, refetch } = trpc.livelox.importClass.useQuery(
    { classId: classId! },
    { enabled: classId != null && !isNaN(classId), retry: 1, staleTime: 5 * 60_000 },
  );

  // ── No classId yet — show input form ──
  if (classId == null) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-w-lg w-full space-y-4">
          <h1 className="text-white text-xl font-bold">Route Replay</h1>

          {/* Mode tabs */}
          <div className="flex gap-1 bg-slate-800 p-1 rounded">
            <button
              onClick={() => setMode("livelox")}
              className={`flex-1 py-1.5 text-sm rounded transition-colors ${
                mode === "livelox"
                  ? "bg-blue-600 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Livelox URL
            </button>
            <button
              onClick={() => setMode("eventor")}
              className={`flex-1 py-1.5 text-sm rounded transition-colors ${
                mode === "eventor"
                  ? "bg-blue-600 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Eventor Event ID
            </button>
          </div>

          {mode === "livelox" ? (
            <>
              <p className="text-slate-400 text-sm">
                Paste a Livelox viewer URL to load and replay GPS routes.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleLoadUrl()}
                  placeholder="https://www.livelox.com/Viewer/...?classId=12345"
                  className="flex-1 bg-slate-800 text-white text-sm px-3 py-2 rounded border border-slate-700 focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={handleLoadUrl}
                  disabled={!inputUrl.includes("classId=")}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Load
                </button>
              </div>
              <p className="text-slate-600 text-xs">
                Example: https://www.livelox.com/Viewer/Nykopingsorienteringen/Svart-5-0?classId=1125893
              </p>
            </>
          ) : (
            <>
              <p className="text-slate-400 text-sm">
                Enter an Eventor event ID to look up the linked Livelox replay.
              </p>
              <input
                type="number"
                value={eventorId}
                onChange={(e) => setEventorId(e.target.value)}
                placeholder="e.g. 27563"
                className="w-full bg-slate-800 text-white text-sm px-3 py-2 rounded border border-slate-700 focus:border-blue-500 focus:outline-none"
              />

              {isResolvingEvent && (
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
                  Looking up Livelox event…
                </div>
              )}

              {resolveError && (
                <div className="space-y-2">
                  <p className="text-red-400 text-sm">{resolveError.message}</p>
                  <button
                    onClick={() => retryResolve()}
                    className="px-3 py-1.5 bg-slate-700 text-white text-sm rounded hover:bg-slate-600 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              )}

              {liveloxEvent && (
                <div className="space-y-2">
                  <p className="text-white text-sm font-medium">{liveloxEvent.eventName}</p>
                  <p className="text-slate-400 text-xs">Select a class to replay:</p>
                  <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
                    {liveloxEvent.classes
                      .filter((c) => c.participantCount > 0)
                      .map((cls) => (
                        <button
                          key={cls.id}
                          onClick={() => setSearchParams({ classId: String(cls.id) })}
                          className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded transition-colors text-left"
                        >
                          <span>{cls.name}</span>
                          <span className="text-slate-500 text-xs">{cls.participantCount} runners</span>
                        </button>
                      ))}
                    {liveloxEvent.classes.filter((c) => c.participantCount === 0).length > 0 && (
                      <>
                        <p className="text-slate-600 text-xs pt-1">Empty classes:</p>
                        {liveloxEvent.classes
                          .filter((c) => c.participantCount === 0)
                          .map((cls) => (
                            <button
                              key={cls.id}
                              onClick={() => setSearchParams({ classId: String(cls.id) })}
                              className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-500 text-sm rounded transition-colors text-left"
                            >
                              <span>{cls.name}</span>
                              <span className="text-xs">0 runners</span>
                            </button>
                          ))}
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="inline-block w-8 h-8 border-4 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
          <p className="text-slate-400 text-sm">
            Loading routes from Livelox...
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="max-md text-center space-y-3">
          <p className="text-red-400 text-sm">{error.message}</p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => refetch()}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-500 transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => setSearchParams({})}
              className="px-4 py-2 bg-slate-700 text-white text-sm rounded hover:bg-slate-600 transition-colors"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Data loaded — show viewer
  if (!data) return null;

  return (
    <div className="h-screen bg-slate-900">
      <ReplayViewer data={data} />
    </div>
  );
}
