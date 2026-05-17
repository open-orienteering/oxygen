import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Test Lab — simplified during the post-MeOS migration. The full race
 * simulator (real-time playback, anomaly injection, ...) is being
 * re-ported against the new PostgreSQL schema. This page currently
 * supports the basic "generate fictional data" actions.
 */
export function TestLabPage() {
  const { t } = useTranslation("common");
  void t;
  const utils = trpc.useUtils();
  const status = trpc.testLab.status.useQuery();
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

  const [runnerCount, setRunnerCount] = useState(50);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Test Lab</h1>
      <p className="text-sm text-amber-700 dark:text-amber-300">
        The full race simulator is being re-ported against the new
        PostgreSQL schema. Basic data generation actions are available
        below; the simulator UI returns once the punch matcher lands.
      </p>

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
              onChange={(e) => setRunnerCount(parseInt(e.target.value, 10) || 50)}
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
    </div>
  );
}

export default TestLabPage;
