/**
 * Playback controls bar for the replay viewer.
 */

import type { FollowMode, ReplayState } from "./useReplayState";

interface Props {
  state: ReplayState;
}

const SPEEDS = [1, 2, 4, 8, 16, 32, 64];

function formatTime(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ReplayControls({ state }: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 text-slate-900 text-sm flex-wrap border-t border-slate-200">
      {/* Play/Pause */}
      <button
        onClick={state.togglePlay}
        className="w-10 h-10 flex items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors flex-shrink-0 cursor-pointer shadow-sm"
        title={state.isPlaying ? "Pause" : "Play"}
      >
        {state.isPlaying ? (
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path d="M5 4h3v12H5V4zm7 0h3v12h-3V4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path d="M6 4l10 6-10 6V4z" />
          </svg>
        )}
      </button>

      {/* Timeline */}
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <span className="text-xs text-slate-500 w-11 text-right tabular-nums flex-shrink-0">
          {formatTime(state.elapsedMs)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.round(state.totalDurationMs))}
          value={Math.round(Math.max(0, state.elapsedMs))}
          onChange={(e) => state.setElapsed(Number(e.target.value))}
          className="flex-1 h-1.5 rounded-full appearance-none bg-slate-300 cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500"
          style={{ accentColor: "#3b82f6" }}
        />
        <span className="text-xs text-slate-500 w-11 tabular-nums flex-shrink-0">
          {formatTime(state.totalDurationMs)}
        </span>
      </div>

      {/* Speed */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => state.setSpeed(s)}
            className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
              state.speed === s
                ? "bg-blue-600 text-white"
                : "text-slate-500 hover:bg-slate-200"
            }`}
          >
            {s}x
          </button>
        ))}
      </div>

      {/* Start mode */}
      <div className="flex items-center gap-0.5 border-l border-slate-300 pl-2 flex-shrink-0">
        {(["mass", "real", "legs"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => state.setStartMode(mode)}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              state.startMode === mode
                ? "bg-blue-600 text-white"
                : "text-slate-500 hover:bg-slate-200"
            }`}
          >
            {mode === "mass" ? "Mass" : mode === "real" ? "Real" : "Legs"}
          </button>
        ))}
      </div>

      {/* Leg navigation (only in legs mode) */}
      {state.startMode === "legs" && (
        <div className="flex items-center gap-1 border-l border-slate-300 pl-2 flex-shrink-0">
          <button
            onClick={state.prevLeg}
            disabled={state.currentLeg === 0}
            className="px-1.5 py-0.5 text-xs rounded text-slate-500 hover:bg-slate-200 disabled:opacity-30 cursor-pointer"
          >
            &larr;
          </button>
          <span className="text-xs text-slate-600 tabular-nums">
            Leg {state.currentLeg + 1}/{state.totalLegs}
          </span>
          <button
            onClick={state.nextLeg}
            disabled={state.currentLeg >= state.totalLegs - 1}
            className="px-1.5 py-0.5 text-xs rounded text-slate-500 hover:bg-slate-200 disabled:opacity-30 cursor-pointer"
          >
            &rarr;
          </button>
        </div>
      )}

      {/* Follow — tri-state: off → all → smart → off
          - "all" pans the camera to the runners' bbox (manual zoom).
          - "smart" additionally widens the bbox to include each runner's
            next un-punched control and lerps the zoom to fit, so the
            camera always frames the action plus its destination. */}
      <div className="flex items-center border-l border-slate-300 pl-2 flex-shrink-0">
        <button
          onClick={() => {
            const next: FollowMode =
              state.followMode === "off"
                ? "all"
                : state.followMode === "all"
                  ? "smart"
                  : "off";
            state.setFollowMode(next);
          }}
          title={
            state.followMode === "smart"
              ? "Smart follow: zoom to runners + next control. Click to disable."
              : state.followMode === "all"
                ? "Follow all runners (pan only). Click to enable smart follow."
                : "Manual control. Click to follow runners."
          }
          className={`px-2 py-0.5 text-xs rounded transition-colors cursor-pointer ${
            state.followMode === "smart"
              ? "bg-blue-600 text-white"
              : state.followMode === "all"
                ? "bg-green-600 text-white"
                : "text-slate-500 hover:bg-slate-200"
          }`}
        >
          {state.followMode === "smart" ? "Smart" : "Follow"}
        </button>
      </div>

      {/* Control restart indicator */}
      {state.restartControlIdx != null && (
        <div className="flex items-center gap-1 border-l border-slate-300 pl-2 flex-shrink-0">
          <span className="text-xs text-amber-600">
            From #{state.restartControlIdx + 1}
          </span>
          <button
            onClick={() => state.restartFromControl(null)}
            className="text-xs text-slate-400 hover:text-slate-900 cursor-pointer"
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
