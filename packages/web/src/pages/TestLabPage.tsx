import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Test Lab — generate fictional event data and drive the race
 * simulator. Used to load-test the kiosk pipeline, exercise the
 * matcher against realistic anomaly rates, and produce screenshots.
 */
export function TestLabPage() {
  const { t } = useTranslation("common");
  void t;
  const utils = trpc.useUtils();
  const status = trpc.testLab.status.useQuery();
  const simStatus = trpc.testLab.simulationStatus.useQuery(undefined, {
    refetchInterval: 1_000,
  });

  const generateClasses = trpc.testLab.generateClasses.useMutation({
    onSuccess: () => utils.invalidate(),
  });
  const generateCourses = trpc.testLab.generateCourses.useMutation({
    onSuccess: () => utils.invalidate(),
  });
  const registerRunners = trpc.testLab.registerFictionalRunners.useMutation({
    onSuccess: () => utils.invalidate(),
  });
  const clearRunners = trpc.testLab.clearRunners.useMutation({
    onSuccess: () => utils.invalidate(),
  });

  const startSimulation = trpc.testLab.startSimulation.useMutation({
    onSuccess: () => utils.testLab.simulationStatus.invalidate(),
  });
  const stopSimulation = trpc.testLab.stopSimulation.useMutation({
    onSuccess: () => utils.testLab.simulationStatus.invalidate(),
  });
  const updateSpeed = trpc.testLab.updateSpeed.useMutation({
    onSuccess: () => utils.testLab.simulationStatus.invalidate(),
  });

  const [runnerCount, setRunnerCount] = useState(50);
  const [speedFactor, setSpeedFactor] = useState(10);
  const [dnsRate, setDnsRate] = useState(0.02);
  const [dnfRate, setDnfRate] = useState(0.05);
  const [mpRate, setMpRate] = useState(0.03);

  const isActive = simStatus.data?.active ?? false;
  const progressPct = Math.round((simStatus.data?.progress ?? 0) * 100);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Test Lab</h1>

      <section className="rounded-lg border bg-white p-4 shadow dark:bg-gray-800">
        <h2 className="mb-2 text-lg font-semibold">Status</h2>
        <ul className="text-sm">
          <li>Classes: {status.data?.classCount ?? 0}</li>
          <li>Courses: {status.data?.courseCount ?? 0}</li>
          <li>Runners: {status.data?.runnerCount ?? 0}</li>
        </ul>
      </section>

      <section className="rounded-lg border bg-white p-4 shadow dark:bg-gray-800 space-y-3">
        <h2 className="text-lg font-semibold">Generate fictional data</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => generateClasses.mutate({ count: 5 })}
            disabled={generateClasses.isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Generate classes
          </button>
          <button
            type="button"
            onClick={() => generateCourses.mutate({ count: 3 })}
            disabled={generateCourses.isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Generate courses
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span>Runners:</span>
            <input
              type="number"
              min={1}
              max={2000}
              value={runnerCount}
              onChange={(e) =>
                setRunnerCount(parseInt(e.target.value, 10) || 50)
              }
              className="w-24 rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-700"
            />
          </label>
          <button
            type="button"
            onClick={() => registerRunners.mutate({ count: runnerCount })}
            disabled={registerRunners.isPending}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Register fictional runners
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm("Delete all runners for this event?")) {
                clearRunners.mutate();
              }
            }}
            disabled={clearRunners.isPending}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Clear runners
          </button>
        </div>
      </section>

      <section className="rounded-lg border bg-white p-4 shadow dark:bg-gray-800 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Race simulator</h2>
          {isActive && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Running · {speedFactor === 0 ? "instant" : `${simStatus.data?.speedFactor}×`}
            </span>
          )}
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-300">
          Generates synthetic SI card readouts for every runner with an assigned
          start time and card. Set <code>Speed factor: 0</code> for instant
          processing (whole event finishes immediately), or any positive value
          for real-time playback at that multiplier.
        </p>

        {isActive && (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
              <span>
                {simStatus.data?.processed ?? 0} / {simStatus.data?.total ?? 0}{" "}
                runners
              </span>
              <span className="tabular-nums">{progressPct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col text-sm">
            <span className="mb-0.5 font-medium text-slate-700 dark:text-slate-200">
              Speed ×
            </span>
            <input
              type="number"
              min={0}
              max={1000}
              step={1}
              value={speedFactor}
              onChange={(e) =>
                setSpeedFactor(parseFloat(e.target.value) || 0)
              }
              disabled={isActive}
              className="w-full rounded-md border border-gray-300 px-2 py-1 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700"
            />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-0.5 font-medium text-slate-700 dark:text-slate-200">
              DNS rate
            </span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={dnsRate}
              onChange={(e) => setDnsRate(parseFloat(e.target.value) || 0)}
              disabled={isActive}
              className="w-full rounded-md border border-gray-300 px-2 py-1 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700"
            />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-0.5 font-medium text-slate-700 dark:text-slate-200">
              DNF rate
            </span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={dnfRate}
              onChange={(e) => setDnfRate(parseFloat(e.target.value) || 0)}
              disabled={isActive}
              className="w-full rounded-md border border-gray-300 px-2 py-1 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700"
            />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-0.5 font-medium text-slate-700 dark:text-slate-200">
              Missing-punch rate
            </span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={mpRate}
              onChange={(e) => setMpRate(parseFloat(e.target.value) || 0)}
              disabled={isActive}
              className="w-full rounded-md border border-gray-300 px-2 py-1 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700"
            />
          </label>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          {!isActive ? (
            <button
              type="button"
              onClick={() =>
                startSimulation.mutate({
                  speedFactor,
                  dnsRate,
                  dnfRate,
                  mpRate,
                })
              }
              disabled={startSimulation.isPending}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Start simulation
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => stopSimulation.mutate()}
                disabled={stopSimulation.isPending}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Stop simulation
              </button>
              <label className="ml-3 flex items-center gap-2 text-sm">
                <span>Live speed ×</span>
                <input
                  type="number"
                  min={0.1}
                  max={1000}
                  step={1}
                  defaultValue={simStatus.data?.speedFactor ?? speedFactor}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (v > 0)
                      updateSpeed.mutate({ speedFactor: v });
                  }}
                  className="w-20 rounded-md border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-700"
                />
              </label>
            </>
          )}
        </div>

        {startSimulation.error && (
          <p className="text-sm text-red-600">
            {startSimulation.error.message}
          </p>
        )}
      </section>
    </div>
  );
}

export default TestLabPage;
