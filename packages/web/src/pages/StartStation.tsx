import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { formatMeosTime } from "@oxygen/shared";
import { useSearchParam } from "../hooks/useSearchParam";

export function StartStation() {
  const { t } = useTranslation("race");
  const [cardInput, setCardInput] = useSearchParam("card");
  const inputRef = useRef<HTMLInputElement>(null);

  // Get current time from server
  const serverTime = trpc.race.serverTime.useQuery(undefined, {
    refetchInterval: 1000,
  });

  // Lookup runner by card
  const cardNo = parseInt(cardInput, 10);
  const lookup = trpc.race.lookupByCard.useQuery(
    { cardNo },
    { enabled: cardInput.length >= 3 && !isNaN(cardNo) && cardNo > 0 },
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleClear = () => {
    setCardInput("");
    inputRef.current?.focus();
  };

  const currentTimeDeci = serverTime.data?.deciseconds ?? 0;
  const hasResult = cardInput.length >= 3 && lookup.data;
  const runnerFound = hasResult && lookup.data?.found;
  const unknownCard = hasResult && !lookup.data?.found;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Kiosk header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-100 text-emerald-800 rounded-full text-base font-semibold mb-4">
          <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse" />
          {t("preStart")}
        </div>
        <div className="text-4xl font-bold text-slate-900 tabular-nums">
          {formatMeosTime(currentTimeDeci)}
        </div>
      </div>

      {/* Card input -- large kiosk-friendly */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 mb-8">
        <label className="block text-sm font-medium text-slate-500 mb-3 text-center">
          {t("scanOrEnterCard")}
        </label>
        <div className="flex gap-3">
          <div className="flex-1">
            <input
              ref={inputRef}
              type="number"
              inputMode="numeric"
              value={cardInput}
              onChange={(e) => setCardInput(e.target.value)}
              placeholder={t("cardNumberPlaceholder")}
              className="w-full text-4xl font-bold text-center py-5 px-6 border-2 border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 tabular-nums"
              autoComplete="off"
            />
          </div>
          {cardInput && (
            <button
              onClick={handleClear}
              className="px-5 py-2 text-sm text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer self-center"
            >
              {t("clear", { ns: "common" })}
            </button>
          )}
        </div>
      </div>

      {/* Loading */}
      {lookup.isLoading && cardInput.length >= 3 && (
        <div className="flex items-center justify-center py-16">
          <div className="inline-block w-10 h-10 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
        </div>
      )}

      {/* Unknown card */}
      {unknownCard && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-10 text-center">
          <div className="text-5xl font-black text-red-600 mb-4">
            {t("unknownCard")}
          </div>
          <div className="text-xl text-red-700">
            {t("cardNotRegistered", { card: cardInput })}
          </div>
          <div className="mt-6 text-lg text-red-600 font-medium">
            {t("pleaseVisitSecretariat")}
          </div>
        </div>
      )}

      {/* Runner found -- kiosk display */}
      {runnerFound && lookup.data?.found && (
        <RunnerKiosk
          runner={lookup.data.runner}
          course={lookup.data.course}
          currentTime={currentTimeDeci}
        />
      )}
    </div>
  );
}

// ─── Runner kiosk display ────────────────────────────────────

function RunnerKiosk({
  runner,
  course,
  currentTime,
}: {
  runner: {
    name: string;
    clubName: string;
    className: string;
    startNo: number;
    startTime: number;
    cardNo: number;
  };
  course: { name: string; length: number; controlCount: number } | null;
  currentTime: number;
}) {
  const { t } = useTranslation("race");
  // Countdown to start time
  const timeToStart = runner.startTime > 0 ? runner.startTime - currentTime : 0;
  const countdownMinutes = Math.floor(Math.abs(timeToStart) / 600);
  const countdownSeconds = Math.floor((Math.abs(timeToStart) % 600) / 10);
  const isPast = timeToStart < 0;

  return (
    <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 overflow-hidden">
      {/* Name + club + class */}
      <div className="p-8 text-center border-b border-emerald-200">
        <div className="text-5xl font-black text-slate-900 mb-3">
          {runner.name}
        </div>
        <div className="text-2xl text-slate-600">
          {runner.clubName}
        </div>
        <div className="text-xl text-emerald-700 font-semibold mt-2">
          {runner.className}
          {runner.startNo > 0 && (
            <span className="text-slate-400 font-normal"> &middot; #{runner.startNo}</span>
          )}
        </div>
      </div>

      {/* Course info */}
      {course && (
        <div className="px-8 py-5 border-b border-emerald-200 bg-emerald-50/50">
          <div className="flex items-center justify-center gap-6 text-lg">
            <span className="font-semibold text-slate-700">{course.name}</span>
            <span className="text-slate-400">&middot;</span>
            <span className="text-slate-600">{(course.length / 1000).toFixed(1)} {t("km", { ns: "common" })}</span>
            <span className="text-slate-400">&middot;</span>
            <span className="text-slate-600">{t("nControls", { count: course.controlCount })}</span>
          </div>
        </div>
      )}

      {/* Start time */}
      <div className="p-8 text-center">
        {runner.startTime > 0 ? (
          <>
            <div className="text-sm font-medium text-slate-500 uppercase tracking-wider mb-2">
              {t("startTime")}
            </div>
            <div className="text-6xl font-black tabular-nums text-emerald-700">
              {formatMeosTime(runner.startTime)}
            </div>
            {timeToStart !== 0 && (
              <div className={`mt-3 text-xl font-semibold tabular-nums ${
                isPast ? "text-amber-600" : "text-emerald-600"
              }`}>
                {isPast ? `${t("started")} ` : ""}
                {countdownMinutes > 0 && `${countdownMinutes}m `}
                {countdownSeconds}s
                {isPast ? ` ${t("ago")}` : ` ${t("toStart")}`}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-sm font-medium text-slate-500 uppercase tracking-wider mb-2">
              {t("startTime")}
            </div>
            <div className="text-3xl font-bold text-slate-400">
              {t("notAssigned")}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
