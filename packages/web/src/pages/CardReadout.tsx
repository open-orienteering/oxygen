import { useRef, useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import {
  formatRunningTime,
  RunnerStatus,
  type RunnerStatusValue,
} from "@oxygen/shared";
import { useRunnerStatusLabel } from "../hooks/useStatusLabels";
import { PunchTable, type PunchTableData } from "../components/PunchTable";
import { MapPanel } from "../components/MapPanel";
import { useSearchParam } from "../hooks/useSearchParam";
import { useDeviceManager } from "../context/DeviceManager";
import { useStationSync } from "../hooks/useStationSync";

export function CardReadout() {
  // Pre-fetch and persist all competition data for offline use
  useStationSync(true);
  const { t } = useTranslation("race");
  const [cardInput, setCardInput] = useSearchParam("card");
  const inputRef = useRef<HTMLInputElement>(null);
  const { currentCard, readerStatus, setIsOnCardReadoutPage } = useDeviceManager();
  const [fromReader, setFromReader] = useState(false);
  const lastCardIdRef = useRef<string | null>(null);

  const isReaderActive = readerStatus === "connected" || readerStatus === "reading";

  // Tell the DeviceManager we're on this page (suppresses notifications)
  useEffect(() => {
    setIsOnCardReadoutPage(true);
    return () => setIsOnCardReadoutPage(false);
  }, [setIsOnCardReadoutPage]);

  // Auto-populate when a card is read from the SI reader
  useEffect(() => {
    if (currentCard && currentCard.id !== lastCardIdRef.current) {
      lastCardIdRef.current = currentCard.id;
      setCardInput(String(currentCard.cardNumber));
      setFromReader(true);
      const t = setTimeout(() => setFromReader(false), 3000);
      return () => clearTimeout(t);
    }
  }, [currentCard, setCardInput]);

  const cardNo = parseInt(cardInput, 10);
  const readout = trpc.cardReadout.readout.useQuery(
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

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-lg font-semibold text-slate-900 mb-6">{t("cardReadout")}</h2>

      {/* SI Reader banner */}
      {fromReader && (
        <div className="mb-4 px-4 py-2 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700 flex items-center gap-2" data-testid="from-reader-banner">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {t("cardFromReader")}
        </div>
      )}

      {isReaderActive && !fromReader && !cardInput && (
        <div className="mb-4 px-4 py-2 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-600 flex items-center gap-2">
          <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          {t("readerConnectedHint")}
        </div>
      )}

      {/* Card input */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
        <div className="flex gap-3">
          <div className="flex-1">
            <input
              ref={inputRef}
              type="number"
              inputMode="numeric"
              value={cardInput}
              onChange={(e) => setCardInput(e.target.value)}
              placeholder={t("enterCardNumber")}
              className="w-full text-3xl font-bold text-center py-3 px-6 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-4 focus:border-blue-500 focus:ring-blue-100 tabular-nums"
              autoComplete="off"
            />
          </div>
          {cardInput && (
            <button
              onClick={handleClear}
              className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
            >
              {t("clear", { ns: "common" })}
            </button>
          )}
        </div>
      </div>

      {/* Loading */}
      {readout.isLoading && cardInput.length >= 3 && (
        <div className="flex items-center justify-center py-12">
          <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
        </div>
      )}

      {/* Not found */}
      {readout.data && !readout.data.found && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <div className="text-lg font-medium text-amber-800">
            {t("cardNotFound")}
          </div>
          <div className="text-sm text-amber-600 mt-1">
            {t("noRunnerWithCard", { card: cardInput })}
          </div>
        </div>
      )}

      {/* Readout result */}
      {readout.data?.found && <ReadoutView data={readout.data} onCardReturnedChange={() => readout.refetch()} />}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function toPunchTableData(data: any): PunchTableData {
  return {
    controls: data.controls,
    timing: data.timing,
    course: data.course,
    extraPunches: data.extraPunches,
    missingControls: data.missingControls,
  };
}

// ─── READOUT VIEW ────────────────────────────────────────────

function ReadoutView({ data, onCardReturnedChange }: { data: any; onCardReturnedChange?: () => void }) {
  const { t: tr } = useTranslation("race");
  const statusLabel = useRunnerStatusLabel();
  const t = data.timing;
  const isOK = t.status === RunnerStatus.OK;
  const isMP = t.status === RunnerStatus.MissingPunch;

  const setCardReturned = trpc.runner.setCardReturned.useMutation({
    onSuccess: () => onCardReturnedChange?.(),
  });

  const handleToggleReturned = useCallback(() => {
    setCardReturned.mutate({ runnerId: data.runner.id, returned: !data.cardReturned });
  }, [data.runner.id, data.cardReturned, setCardReturned]);

  return (
    <div className="space-y-4">
      {/* Rental card return banner */}
      {data.isRentalCard && (
        <div className={`rounded-xl px-5 py-4 flex items-center justify-between gap-4 border-2 ${
          data.cardReturned
            ? "bg-emerald-50 border-emerald-200"
            : "bg-amber-50 border-amber-300"
        }`}>
          <div className="flex items-center gap-3 min-w-0">
            <svg className={`w-5 h-5 shrink-0 ${data.cardReturned ? "text-emerald-600" : "text-amber-600"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            <span className={`text-sm font-semibold ${data.cardReturned ? "text-emerald-700" : "text-amber-800"}`}>
              {data.cardReturned ? tr("rentalCardReturned") : tr("returnRentalCard")}
            </span>
          </div>
          <button
            onClick={handleToggleReturned}
            disabled={setCardReturned.isPending}
            className={`shrink-0 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 ${
              data.cardReturned
                ? "bg-slate-100 text-slate-700 hover:bg-slate-200"
                : "bg-amber-600 text-white hover:bg-amber-700"
            }`}
          >
            {data.cardReturned ? tr("markNotReturned") : tr("markReturned")}
          </button>
        </div>
      )}

      {/* Big status banner */}
      <div
        className={`rounded-2xl p-8 text-center ${
          isOK
            ? "bg-emerald-50 border-2 border-emerald-200"
            : isMP
              ? "bg-red-50 border-2 border-red-200"
              : "bg-amber-50 border-2 border-amber-200"
        }`}
      >
        <div className="text-sm font-medium text-slate-500 mb-1">
          {data.runner.name}
        </div>
        <div className="text-xs text-slate-400 mb-4">
          {data.runner.clubName} &middot; {data.runner.className}
        </div>

        {/* Status */}
        <div
          data-testid="readout-status"
          className={`text-4xl font-black ${
            isOK ? "text-emerald-600" : isMP ? "text-red-600" : "text-amber-600"
          }`}
        >
          {statusLabel(t.status as RunnerStatusValue)}
        </div>

        {/* Running time */}
        {t.runningTime > 0 && (
          <div className="text-5xl font-bold tabular-nums mt-3 text-slate-900">
            {formatRunningTime(t.runningTime)}
          </div>
        )}

        {/* Missing controls */}
        {data.missingControls.length > 0 && (
          <div className="mt-4 text-red-700 text-sm font-medium">
            {tr("missingControls", { controls: data.missingControls.join(", ") })}
          </div>
        )}
      </div>

      {/* Course info */}
      {data.course && (
        <div className="text-center text-sm text-slate-500">
          {data.course.name} &middot; {(data.course.length / 1000).toFixed(1)}{" "}
          {tr("km", { ns: "common" })} &middot; {tr("nControls", { count: data.course.controlCount })}
        </div>
      )}

      {/* Mispunch map — immediately after status, before the split table */}
      {data.course && (data.missingControls.length > 0 || data.extraPunches.length > 0) && (
        <MispunchMap
          courseName={data.course.name}
          controls={data.controls}
          extraPunches={data.extraPunches}
        />
      )}

      {/* Punch table (read-only) */}
      <PunchTable data={toPunchTableData(data)} />
    </div>
  );
}

function MispunchMap({ courseName, controls, extraPunches }: {
  courseName: string;
  controls: { controlCode: number; status: "ok" | "missing" | "extra" }[];
  extraPunches: { controlCode: number }[];
}) {
  const { t } = useTranslation("race");
  const punchStatusByCode: Record<string, "ok" | "missing" | "extra"> = {};
  for (const c of controls) punchStatusByCode[String(c.controlCode)] = c.status;
  for (const ep of extraPunches) punchStatusByCode[String(ep.controlCode)] = "extra";

  // Zoom to bounding box of mispunched + extra controls
  const focusControlCodes = [
    ...controls.filter((c) => c.status === "missing").map((c) => String(c.controlCode)),
    ...extraPunches.map((ep) => String(ep.controlCode)),
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-slate-600">{t("courseMap")}</span>
        <span className="flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            {/* Missing: circle with X */}
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="#ef4444" strokeWidth="1.5" />
              <line x1="4" y1="4" x2="10" y2="10" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="10" y1="4" x2="4" y2="10" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {t("missing")}
          </span>
          <span className="flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="#f97316" strokeWidth="1.5" />
            </svg>
            {t("extraPunch")}
          </span>
          <span className="flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="#059669" strokeWidth="1.5" />
            </svg>
            {t("correct")}
          </span>
        </span>
      </div>
      <MapPanel
        highlightCourseName={courseName}
        filterMode="course"
        height="450px"
        fitToControls
        punchStatusByCode={punchStatusByCode}
        focusControlCodes={focusControlCodes}
      />
    </div>
  );
}
