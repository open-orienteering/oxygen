import { useState, useRef, useEffect } from "react";
import { trpc } from "../lib/trpc";
import { formatMeosTime, formatRunningTime, runnerStatusLabel, type RunnerStatusValue } from "@oxygen/shared";
import { StatusBadge } from "../components/StatusBadge";

export function FinishStation() {
  const [cardInput, setCardInput] = useState("");
  const [lastAction, setLastAction] = useState<{
    type: "success" | "error";
    message: string;
    runningTime?: number;
    time: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const serverTime = trpc.race.serverTime.useQuery(undefined, {
    refetchInterval: 10000,
  });

  const lookup = trpc.race.lookupByCard.useQuery(
    { cardNo: parseInt(cardInput, 10) },
    { enabled: cardInput.length >= 3 && !isNaN(parseInt(cardInput, 10)) },
  );

  const recordFinish = trpc.race.recordFinish.useMutation({
    onSuccess: (data) => {
      setLastAction({
        type: "success",
        message: `${data.name} finished`,
        runningTime: data.runningTime,
        time: Date.now(),
      });
      setCardInput("");
      inputRef.current?.focus();
      utils.race.recentActivity.invalidate();
      utils.race.lookupByCard.invalidate();
      utils.runner.list.invalidate();
      utils.lists.resultList.invalidate();
    },
    onError: (err) => {
      setLastAction({
        type: "error",
        message: err.message,
        time: Date.now(),
      });
    },
  });

  const recentActivity = trpc.race.recentActivity.useQuery({ limit: 15 });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleRecordFinish = () => {
    if (!lookup.data?.found) return;
    const now = new Date();
    const deciseconds =
      (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;
    recordFinish.mutate({
      runnerId: lookup.data.runner.id,
      finishTime: deciseconds,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && lookup.data?.found) {
      handleRecordFinish();
    }
  };

  const currentTimeDeci = serverTime.data?.deciseconds ?? 0;

  return (
    <div className="max-w-2xl mx-auto">
      {/* Station header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-blue-100 text-blue-800 rounded-full text-sm font-medium mb-4">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          Finish Station
        </div>
        <div className="text-3xl font-bold text-slate-900 tabular-nums">
          {formatMeosTime(currentTimeDeci)}
        </div>
      </div>

      {/* Card input */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
        <label className="block text-sm font-medium text-slate-500 mb-2">
          Scan or enter SI card number
        </label>
        <input
          ref={inputRef}
          type="number"
          inputMode="numeric"
          value={cardInput}
          onChange={(e) => setCardInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Card number..."
          className="w-full text-3xl font-bold text-center py-4 px-6 border-2 border-slate-200 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100 tabular-nums"
          autoComplete="off"
        />

        {cardInput.length >= 3 && lookup.data && (
          <div className="mt-4">
            {lookup.data.found ? (
              <div className="bg-blue-50 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-bold text-slate-900">
                      {lookup.data.runner.name}
                    </div>
                    <div className="text-sm text-slate-600">
                      {lookup.data.runner.clubName} &middot;{" "}
                      {lookup.data.runner.className}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      Start: {formatMeosTime(lookup.data.runner.startTime)}
                      {lookup.data.runner.finishTime > 0 && (
                        <span className="text-amber-600 font-medium ml-2">
                          Already finished at{" "}
                          {formatMeosTime(lookup.data.runner.finishTime)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleRecordFinish}
                  disabled={recordFinish.isPending}
                  className="w-full mt-4 py-4 bg-blue-600 text-white text-lg font-bold rounded-xl hover:bg-blue-700 active:bg-blue-800 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {recordFinish.isPending ? "Recording..." : "Record Finish"}
                </button>
              </div>
            ) : (
              <div className="bg-amber-50 rounded-xl p-4 text-amber-800">
                <div className="font-medium">Card not found</div>
                <div className="text-sm mt-1">
                  No runner with card {cardInput} in this competition
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Last action feedback */}
      {lastAction && Date.now() - lastAction.time < 15000 && (
        <div
          className={`rounded-xl p-4 mb-6 text-center ${
            lastAction.type === "success"
              ? "bg-emerald-100 text-emerald-800"
              : "bg-red-100 text-red-800"
          }`}
        >
          <div className="text-lg font-medium">{lastAction.message}</div>
          {lastAction.runningTime && lastAction.runningTime > 0 && (
            <div className="text-2xl font-bold mt-1 tabular-nums">
              {formatRunningTime(lastAction.runningTime)}
            </div>
          )}
        </div>
      )}

      {/* Recent finishers */}
      <div>
        <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
          Recent Finishers
        </h3>
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {recentActivity.data?.length === 0 && (
            <div className="px-4 py-6 text-center text-slate-400 text-sm">
              No finishers yet
            </div>
          )}
          {recentActivity.data?.map((r) => (
            <div key={r.id} className="px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-slate-900">{r.name}</div>
                <div className="text-xs text-slate-500">
                  {r.clubName} &middot; {r.className}
                </div>
              </div>
              <div className="text-right flex items-center gap-3">
                {r.runningTime > 0 && (
                  <span className="text-sm font-bold tabular-nums text-slate-900">
                    {formatRunningTime(r.runningTime)}
                  </span>
                )}
                <StatusBadge status={r.status as RunnerStatusValue} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
