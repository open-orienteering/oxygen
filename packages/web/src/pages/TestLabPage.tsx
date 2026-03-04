import { useState, useEffect, useCallback } from "react";
import { trpc } from "../lib/trpc";

type SimSpeed = 0 | 1 | 10 | 50;

const SPEED_OPTIONS: { value: SimSpeed; label: string }[] = [
  { value: 0, label: "Instant" },
  { value: 1, label: "1x (real-time)" },
  { value: 10, label: "10x" },
  { value: 50, label: "50x" },
];

export function TestLabPage() {
  const utils = trpc.useUtils();
  const status = trpc.testLab.status.useQuery(undefined, { refetchInterval: 5000 });
  const simStatus = trpc.testLab.simulationStatus.useQuery(undefined, {
    refetchInterval: (query) => (query.state.data?.running ? 1000 : false),
  });

  const [runnerCount, setRunnerCount] = useState(200);
  const [simSpeed, setSimSpeed] = useState<SimSpeed>(10);
  const [lastResult, setLastResult] = useState<Record<string, string>>({});

  const generateClasses = trpc.testLab.generateClasses.useMutation({
    onSuccess: (data) => {
      setLastResult((prev) => ({
        ...prev,
        classes: `Created ${data.created} classes (${data.skipped} skipped)`,
      }));
      utils.testLab.status.invalidate();
      utils.class.list.invalidate();
      utils.competition.dashboard.invalidate();
    },
  });

  const generateCourses = trpc.testLab.generateCourses.useMutation({
    onSuccess: (data) => {
      setLastResult((prev) => ({
        ...prev,
        courses: `${data.controlsCreated} controls (${data.firstControlGroups} first-control groups), ${data.coursesCreated} courses, ${data.classesAssigned} classes assigned`,
      }));
      utils.testLab.status.invalidate();
      utils.course.list.invalidate();
      utils.control.list.invalidate();
      utils.class.list.invalidate();
      utils.competition.dashboard.invalidate();
    },
  });

  const registerRunners = trpc.testLab.registerRunners.useMutation({
    onSuccess: (data) => {
      setLastResult((prev) => ({
        ...prev,
        runners: `Registered ${data.created} runners from ${data.clubsCreated} clubs`,
      }));
      utils.testLab.status.invalidate();
      utils.runner.list.invalidate();
      utils.competition.dashboard.invalidate();
    },
  });

  const registerFictionalRunners = trpc.testLab.registerFictionalRunners.useMutation({
    onSuccess: (data) => {
      setLastResult((prev) => ({
        ...prev,
        runners: `Registered ${data.created} fictional runners from ${data.clubsCreated} clubs (GDPR-safe)`,
      }));
      utils.testLab.status.invalidate();
      utils.runner.list.invalidate();
      utils.competition.dashboard.invalidate();
    },
  });

  const startSimulation = trpc.testLab.startSimulation.useMutation({
    onSuccess: (data) => {
      setLastResult((prev) => ({
        ...prev,
        simulation: data.mode === "instant"
          ? `Processed ${data.processed} readouts instantly`
          : `Started simulation (${data.total} readouts)`,
      }));
      utils.testLab.simulationStatus.invalidate();
    },
  });

  const stopSimulation = trpc.testLab.stopSimulation.useMutation({
    onSuccess: (data) => {
      setLastResult((prev) => ({
        ...prev,
        simulation: data.stopped
          ? `Stopped after ${data.processed}/${data.total} readouts`
          : "No simulation running",
      }));
      utils.testLab.simulationStatus.invalidate();
    },
  });

  const updateSpeed = trpc.testLab.updateSpeed.useMutation();

  // Sync UI speed with server when simulation is running
  const isSimRunning = simStatus.data?.running ?? false;
  const serverSpeed = simStatus.data?.speed;
  useEffect(() => {
    if (isSimRunning && serverSpeed && serverSpeed !== simSpeed) {
      setSimSpeed(serverSpeed as SimSpeed);
    }
  }, [isSimRunning, serverSpeed]);

  // Invalidate result caches while simulation is running
  const invalidateResults = useCallback(() => {
    utils.runner.list.invalidate();
    utils.cardReadout.cardList.invalidate();
    utils.competition.dashboard.invalidate();
  }, [utils]);

  useEffect(() => {
    if (!isSimRunning) return;
    const interval = setInterval(invalidateResults, 3000);
    return () => clearInterval(interval);
  }, [isSimRunning, invalidateResults]);

  const s = status.data;
  const hasClasses = (s?.classes ?? 0) > 0;
  const hasCourses = (s?.courses ?? 0) > 0;
  const hasRunners = (s?.runners ?? 0) > 0;
  const hasStartTimes = (s?.runnersWithStart ?? 0) > 0;

  const anyLoading =
    generateClasses.isPending ||
    generateCourses.isPending ||
    registerRunners.isPending ||
    registerFictionalRunners.isPending ||
    startSimulation.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Test Lab</h2>
        <p className="text-sm text-slate-500 mt-1">
          Generate test data and simulate races for stress testing. Work through the four stages
          in order &mdash; each stage depends on the previous one.
        </p>
      </div>

      {/* Status overview */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatusBadge label="Classes" count={s?.classes ?? 0} />
        <StatusBadge label="Courses" count={s?.courses ?? 0} />
        <StatusBadge label="Controls" count={s?.controls ?? 0} />
        <StatusBadge label="Runners" count={s?.runners ?? 0} />
        <StatusBadge label="With start" count={s?.runnersWithStart ?? 0} />
      </div>

      {/* Stage 1: Classes */}
      <StageCard
        number={1}
        title="Generate Classes"
        description="Create a standard Swedish long-distance class setup (38 classes)."
        ready={true}
        done={hasClasses}
        result={lastResult.classes}
        error={generateClasses.error?.message}
        details={<>
          <p>Creates <strong>38 classes</strong> with correct Sex, LowAge, HighAge, and SortIndex:</p>
          <ul className="list-disc ml-4 mt-1 space-y-0.5">
            <li><strong>Youth</strong> &mdash; H/D 10, 12, 14, 16 (8 classes)</li>
            <li><strong>Junior/Senior</strong> &mdash; H/D 18, 20, 21 (6 classes)</li>
            <li><strong>Veteran</strong> &mdash; H/D 35, 40, 45, 50, 55, 60, 65, 70, 75, 80 (20 classes)</li>
            <li><strong>Open</strong> &mdash; Inskolning, Öppen kort, Öppen mellan, Öppen lång (4 classes)</li>
          </ul>
          <p className="mt-1.5">Skips classes that already exist, so it&apos;s safe to run multiple times.</p>
        </>}
      >
        <button
          onClick={() => generateClasses.mutate()}
          disabled={anyLoading}
          className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          data-testid="generate-classes"
        >
          {generateClasses.isPending ? "Generating..." : "Generate Classes"}
        </button>
      </StageCard>

      {/* Stage 2: Courses & Controls */}
      <StageCard
        number={2}
        title="Generate Courses & Controls"
        description="Create 8 courses with ~50 controls, 4 different first controls, and realistic control sharing."
        ready={hasClasses}
        done={hasCourses}
        result={lastResult.courses}
        error={generateCourses.error?.message}
        details={<>
          <p className="mb-2">All courses share one start (Start 1) but use <strong>4 different first controls</strong> so the draw can separate consecutive starters heading to different controls. Longer courses are supersets with ~60% shared body controls between adjacent tiers.</p>
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-left">
                <th className="py-1 pr-2">Course</th>
                <th className="py-1 pr-2">Controls</th>
                <th className="py-1 pr-2">Length</th>
                <th className="py-1 pr-2">1st ctrl</th>
                <th className="py-1">Assigned to</th>
              </tr>
            </thead>
            <tbody className="text-slate-600">
              <tr><td className="py-0.5 pr-2">Bana 1 (Mycket lätt)</td><td className="pr-2">5</td><td className="pr-2">2 km</td><td className="pr-2">A</td><td>H/D 10, Inskolning</td></tr>
              <tr><td className="py-0.5 pr-2">Bana 2 (Lätt)</td><td className="pr-2">8</td><td className="pr-2">3.5 km</td><td className="pr-2">B</td><td>H/D 12, H/D 75-80, Öppen kort</td></tr>
              <tr><td className="py-0.5 pr-2">Bana 3 (Lätt-medel)</td><td className="pr-2">10</td><td className="pr-2">4.5 km</td><td className="pr-2">A</td><td>H/D 14, H/D 55-65</td></tr>
              <tr><td className="py-0.5 pr-2">Bana 4 (Medel)</td><td className="pr-2">13</td><td className="pr-2">5.5 km</td><td className="pr-2">C</td><td>H/D 16, H/D 45-60, Öppen mellan</td></tr>
              <tr><td className="py-0.5 pr-2">Bana 5 (Medel-svår)</td><td className="pr-2">15</td><td className="pr-2">7 km</td><td className="pr-2">B</td><td>H/D 18, H/D 35-50, Öppen lång</td></tr>
              <tr><td className="py-0.5 pr-2">Bana 6 (Svår)</td><td className="pr-2">18</td><td className="pr-2">9 km</td><td className="pr-2">D</td><td>H/D 20, H/D 35-40</td></tr>
              <tr><td className="py-0.5 pr-2">Bana 7 (Dam lång)</td><td className="pr-2">20</td><td className="pr-2">10.5 km</td><td className="pr-2">C</td><td>D21</td></tr>
              <tr><td className="py-0.5 pr-2">Bana 8 (Herr lång)</td><td className="pr-2">24</td><td className="pr-2">12.5 km</td><td className="pr-2">D</td><td>H21</td></tr>
            </tbody>
          </table>
          <p className="mt-2 text-slate-400">A-D are randomized control codes; the actual codes change each time you regenerate.</p>
        </>}
      >
        <button
          onClick={() => generateCourses.mutate()}
          disabled={anyLoading || !hasClasses}
          className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          data-testid="generate-courses"
        >
          {generateCourses.isPending ? "Generating..." : "Generate Courses & Controls"}
        </button>
      </StageCard>

      {/* Stage 3: Register Runners */}
      <StageCard
        number={3}
        title="Register Runners"
        description="Distribute runners across classes using real or fictional data."
        ready={hasClasses && hasCourses}
        done={hasRunners}
        result={lastResult.runners}
        error={registerRunners.error?.message || registerFictionalRunners.error?.message}
        details={<>
          <p className="font-medium">From Eventor DB:</p>
          <p>Queries <strong>oxygen_runner_db</strong> (synced from Eventor) for runners with valid birth year and SI card. Requires a synced runner database.</p>
          <p className="font-medium mt-2">Fictional (GDPR-safe):</p>
          <p>Generates fictional runners with random Swedish names and randomized SI card types (SI5, SI8, SI9, SI10, SIAC). No external database required &mdash; fully self-contained.</p>
          <p className="mt-2">Both modes distribute runners with realistic weights: H/D 21 get the most (~10-15% each), veteran decreasing with age, youth smaller counts, open classes a few.</p>
        </>}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-600">Total runners:</label>
            <input
              type="number"
              min={10}
              max={5000}
              value={runnerCount}
              onChange={(e) => setRunnerCount(Math.max(10, Math.min(5000, parseInt(e.target.value) || 200)))}
              className="w-24 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              data-testid="runner-count-input"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => registerFictionalRunners.mutate({ count: runnerCount })}
              disabled={anyLoading || !hasClasses || !hasCourses}
              className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              data-testid="register-fictional-runners"
            >
              {registerFictionalRunners.isPending ? "Generating..." : "Fictional (GDPR-safe)"}
            </button>
            <button
              onClick={() => registerRunners.mutate({ count: runnerCount })}
              disabled={anyLoading || !hasClasses || !hasCourses}
              className="px-4 py-2 bg-slate-600 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              data-testid="register-runners"
            >
              {registerRunners.isPending ? "Registering..." : "From Eventor DB"}
            </button>
          </div>
        </div>
      </StageCard>

      {/* Stage 4: Simulation */}
      <StageCard
        number={4}
        title="Race Simulation"
        description="Simulate a race by generating realistic punch data for all runners with start times."
        ready={hasStartTimes}
        done={false}
        result={lastResult.simulation}
        error={startSimulation.error?.message || stopSimulation.error?.message}
        details={<>
          <p className="font-medium">Prerequisites:</p>
          <p className="mb-2">Draw start times first using the <strong>Start List</strong> page. Only runners with a start time and valid SI card are included.</p>
          <p className="font-medium">How it works:</p>
          <ul className="list-disc ml-4 mt-1 space-y-0.5">
            <li>Generates realistic running times based on course length and tier difficulty (elite ~5:30 min/km, youth ~10 min/km)</li>
            <li>Splits are distributed across legs with normal-distribution variation</li>
            <li>Includes anomalies: ~5% DNF, ~3% mispunch, ~2% DNS (no readout)</li>
            <li>Builds MeOS-compatible punch strings and creates <strong>oCard</strong> entries, then updates <strong>oRunner</strong> status/times</li>
          </ul>
          <p className="mt-2 font-medium">Speed modes:</p>
          <ul className="list-disc ml-4 mt-1 space-y-0.5">
            <li><strong>Instant</strong> &mdash; processes all readouts immediately</li>
            <li><strong>1x / 10x / 50x</strong> &mdash; server-side timer triggers readouts at simulated time, adjustable while running</li>
          </ul>
          <p className="mt-1 text-slate-400">The simulation runs server-side so it doesn&apos;t depend on keeping the browser tab open.</p>
        </>}
      >
        <div className="space-y-4">
          {/* Speed selector */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-600">Speed:</label>
            <div className="flex gap-1">
              {SPEED_OPTIONS.map((opt) => {
                const isDisabledDuringRun = isSimRunning && opt.value === 0;
                return (
                  <button
                    key={opt.value}
                    onClick={() => {
                      setSimSpeed(opt.value);
                      if (isSimRunning && opt.value > 0) {
                        updateSpeed.mutate({ speed: opt.value });
                      }
                    }}
                    disabled={isDisabledDuringRun}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                      simSpeed === opt.value
                        ? "bg-amber-100 text-amber-800 ring-1 ring-amber-300"
                        : isDisabledDuringRun
                          ? "bg-slate-50 text-slate-300 cursor-not-allowed"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Start/Stop buttons */}
          <div className="flex items-center gap-3">
            {isSimRunning ? (
              <button
                onClick={() => stopSimulation.mutate()}
                disabled={stopSimulation.isPending}
                className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors cursor-pointer"
                data-testid="stop-simulation"
              >
                {stopSimulation.isPending ? "Stopping..." : "Stop Simulation"}
              </button>
            ) : (
              <button
                onClick={() => startSimulation.mutate({ speed: simSpeed })}
                disabled={anyLoading || !hasStartTimes || startSimulation.isPending}
                className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                data-testid="start-simulation"
              >
                {startSimulation.isPending ? "Starting..." : "Start Simulation"}
              </button>
            )}
          </div>

          {/* Progress */}
          {simStatus.data && simStatus.data.total > 0 && (
            <SimulationProgress
              running={simStatus.data.running}
              processed={simStatus.data.processed}
              total={simStatus.data.total}
              elapsedMs={simStatus.data.elapsedMs}
            />
          )}
        </div>
      </StageCard>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────

function StatusBadge({ label, count }: { label: string; count: number }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 px-3 py-2 text-center">
      <div className="text-lg font-semibold text-slate-900">{count}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function StageCard({
  number,
  title,
  description,
  ready,
  done,
  result,
  error,
  details,
  children,
}: {
  number: number;
  title: string;
  description: string;
  ready: boolean;
  done: boolean;
  result?: string;
  error?: string;
  details?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`bg-white rounded-lg border p-5 transition-opacity ${
        ready ? "border-slate-200" : "border-slate-100 opacity-60"
      }`}
    >
      <div className="flex items-start gap-3 mb-3">
        <span
          className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
            done
              ? "bg-green-100 text-green-700"
              : ready
                ? "bg-amber-100 text-amber-700"
                : "bg-slate-100 text-slate-400"
          }`}
        >
          {done ? "\u2713" : number}
        </span>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {description}
            {details && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="ml-1.5 text-amber-600 hover:text-amber-800 font-medium cursor-pointer"
              >
                {expanded ? "Less" : "More..."}
              </button>
            )}
          </p>
          {details && expanded && (
            <div className="mt-2 text-sm text-slate-600 bg-slate-50 rounded-lg p-3 border border-slate-100">
              {details}
            </div>
          )}
        </div>
      </div>

      <div className="ml-10">
        {children}

        {result && (
          <div className="mt-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            {result}
          </div>
        )}
        {error && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function SimulationProgress({
  running,
  processed,
  total,
  elapsedMs,
}: {
  running: boolean;
  processed: number;
  total: number;
  elapsedMs: number;
}) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const elapsedSec = Math.round(elapsedMs / 1000);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {processed} / {total} readouts ({pct}%)
        </span>
        <span>
          {running ? "Running" : "Finished"} &mdash; {elapsedSec}s elapsed
        </span>
      </div>
      <div className="w-full bg-slate-200 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-500 ${
            running ? "bg-amber-500" : "bg-green-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
