import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { getCardType } from "../lib/si-protocol";
import type { SICardReadout } from "../lib/si-protocol";

type SimSpeed = 0 | 1 | 10 | 50;

const SPEED_OPTIONS: { value: SimSpeed; label: string }[] = [
  { value: 0, label: "Instant" },
  { value: 1, label: "1x (real-time)" },
  { value: 10, label: "10x" },
  { value: 50, label: "50x" },
];

// ─── Helpers ──────────────────────────────────────────────

/** Format seconds since midnight as HH:MM:SS */
function fmtSec(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Parse HH:MM:SS string to seconds since midnight */
function parseSec(str: string): number | null {
  const parts = str.split(":");
  if (parts.length !== 3) return null;
  const [h, m, s] = parts.map(Number);
  if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
  return h * 3600 + m * 60 + s;
}

// ─── Types ────────────────────────────────────────────────

interface EditablePunch {
  controlCode: number;
  time: number; // seconds since midnight
}

interface ReadoutPreview {
  runnerId: number;
  cardNo: number;
  runnerName: string;
  className: string;
  courseName: string;
  courseLength: number;
  controlCount: number;
  startTime: number;
  checkTime: number;
  clearTime: number;
  finishTime: number | null;
  status: number;
  punches: EditablePunch[];
  dayOfWeek: number; // 1-7 (Mon-Sun)
}

export function TestLabPage() {
  const { t } = useTranslation("common");
  const { nameId } = useParams<{ nameId: string }>();
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

  const quickDraw = trpc.testLab.quickDraw.useMutation({
    onSuccess: (data) => {
      setLastResult((prev) => ({
        ...prev,
        draw: `Drew ${data.totalDrawn} runners across ${data.classesDrawn} classes`,
      }));
      utils.testLab.status.invalidate();
      utils.runner.list.invalidate();
      utils.draw.defaults.invalidate();
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
    quickDraw.isPending ||
    startSimulation.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">{t("testLab")}</h2>
        <p className="text-sm text-slate-500 mt-1">
          {t("testLabDescription")}
        </p>
      </div>

      {/* Status overview */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatusBadge label={t("classes")} count={s?.classes ?? 0} />
        <StatusBadge label={t("courses")} count={s?.courses ?? 0} />
        <StatusBadge label={t("controls")} count={s?.controls ?? 0} />
        <StatusBadge label={t("runners")} count={s?.runners ?? 0} />
        <StatusBadge label={t("withStart")} count={s?.runnersWithStart ?? 0} />
      </div>

      {/* Stage 1: Classes */}
      <StageCard
        number={1}
        title={t("generateClasses")}
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
          {generateClasses.isPending ? t("generating") : t("generateClasses")}
        </button>
      </StageCard>

      {/* Stage 2: Courses & Controls */}
      <StageCard
        number={2}
        title={t("generateCoursesAndControls")}
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
          {generateCourses.isPending ? t("generating") : t("generateCoursesAndControls")}
        </button>
      </StageCard>

      {/* Stage 3: Register Runners */}
      <StageCard
        number={3}
        title={t("registerRunners")}
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
            <label className="text-sm text-slate-600">{t("totalRunners")}</label>
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
              {registerFictionalRunners.isPending ? t("generating") : t("fictionalGdprSafe")}
            </button>
            <button
              onClick={() => registerRunners.mutate({ count: runnerCount })}
              disabled={anyLoading || !hasClasses || !hasCourses}
              className="px-4 py-2 bg-slate-600 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
              data-testid="register-runners"
            >
              {registerRunners.isPending ? t("registering") : t("fromEventorDb")}
            </button>
          </div>
        </div>
      </StageCard>

      {/* Stage 4: Quick Draw */}
      <StageCard
        number={4}
        title="Quick Draw"
        description="Auto-draw all non-free-start classes with random start order and 2-minute intervals."
        ready={hasRunners}
        done={hasStartTimes}
        result={lastResult.draw}
        error={quickDraw.error?.message}
        details={<>
          <p>Draws all classes with sensible defaults:</p>
          <ul className="list-disc ml-4 mt-1 space-y-0.5">
            <li><strong>Method:</strong> Random</li>
            <li><strong>Interval:</strong> 2 minutes between starts</li>
            <li><strong>First start:</strong> Competition zero time (typically 09:00)</li>
            <li><strong>Max parallel starts:</strong> 1</li>
          </ul>
          <p className="mt-1.5">Skips free-start classes. Uses the same draw engine as the Start List page.</p>
        </>}
      >
        <button
          onClick={() => quickDraw.mutate()}
          disabled={anyLoading || !hasRunners}
          className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          data-testid="quick-draw"
        >
          {quickDraw.isPending ? "Drawing..." : "Quick Draw"}
        </button>
      </StageCard>

      {/* Stage 5: Simulation */}
      <StageCard
        number={5}
        title={t("raceSimulation")}
        description="Simulate a race by generating realistic punch data for all runners with start times."
        ready={hasStartTimes}
        done={false}
        result={lastResult.simulation}
        error={startSimulation.error?.message || stopSimulation.error?.message}
        details={<>
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
            <label className="text-sm text-slate-600">{t("speed")}:</label>
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
                {stopSimulation.isPending ? t("stopping") : t("stopSimulation")}
              </button>
            ) : (
              <button
                onClick={() => startSimulation.mutate({ speed: simSpeed })}
                disabled={anyLoading || !hasStartTimes || startSimulation.isPending}
                className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                data-testid="start-simulation"
              >
                {startSimulation.isPending ? t("starting") : t("startSimulation")}
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

      {/* Stage 6: Readout Generator */}
      <StageCard
        number={6}
        title="Readout Generator"
        description="Generate and inject fake SI card readouts via BroadcastChannel to DeviceManager."
        ready={hasRunners}
        done={false}
        result={lastResult.readout}
        error={undefined}
        details={<>
          <p>Pick a runner, choose a status, then edit the generated punch data before injecting.</p>
          <p className="mt-1">The injected readout flows through the <strong>full DeviceManager pipeline</strong> (store, action resolution, kiosk broadcast) &mdash; identical to a real SI card read.</p>
          <p className="mt-1 text-slate-400">Requires the admin tab to be open with the same competition selected.</p>
        </>}
      >
        <ReadoutGenerator nameId={nameId} onResult={(msg) => setLastResult((prev) => ({ ...prev, readout: msg }))} />
      </StageCard>
    </div>
  );
}

// ─── Readout Generator ──────────────────────────────────────

function ReadoutGenerator({ nameId, onResult }: { nameId?: string; onResult: (msg: string) => void }) {
  const [search, setSearch] = useState("");
  const [selectedRunnerId, setSelectedRunnerId] = useState<number | null>(null);
  const [preview, setPreview] = useState<ReadoutPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customCardNo, setCustomCardNo] = useState("");
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Runner search
  const runnerList = trpc.runner.list.useQuery(
    { search: search.length >= 2 ? search : undefined },
    { enabled: search.length >= 2 },
  );

  const generateReadout = trpc.testLab.generateReadout.useMutation({
    onSuccess: (data) => {
      // Convert JS day (0=Sun..6=Sat) to SI day (1=Mon..7=Sun)
      const jsDay = new Date().getDay();
      const todaySIDow = jsDay === 0 ? 7 : jsDay;
      setPreview({
        ...data,
        dayOfWeek: todaySIDow,
      });
      setError(null);
    },
    onError: (err) => setError(err.message),
  });

  // Clean up BroadcastChannel
  useEffect(() => {
    return () => channelRef.current?.close();
  }, []);

  const handleGenerate = (mode: "ok" | "mp" | "dnf" | "dns") => {
    if (!selectedRunnerId) return;
    generateReadout.mutate({ runnerId: selectedRunnerId, mode });
  };

  const handleInject = () => {
    if (!preview || !nameId) return;

    const readout: SICardReadout = {
      cardNumber: preview.cardNo,
      cardType: getCardType(preview.cardNo),
      checkTime: preview.checkTime > 0 ? preview.checkTime : null,
      startTime: preview.startTime > 0 ? preview.startTime : null,
      finishTime: preview.finishTime,
      clearTime: preview.clearTime > 0 ? preview.clearTime : null,
      finishDayOfWeek: preview.finishTime ? preview.dayOfWeek : null,
      checkDayOfWeek: preview.checkTime > 0 ? preview.dayOfWeek : null,
      punches: preview.punches.map((p) => ({
        controlCode: p.controlCode,
        time: p.time,
      })),
      punchCount: preview.punches.length,
      ownerData: null,
      batteryVoltage: null,
      metadata: null,
    };

    // Send via BroadcastChannel to admin tab's DeviceManager
    if (!channelRef.current) {
      channelRef.current = new BroadcastChannel(`oxygen-testlab-${nameId}`);
    }
    channelRef.current.postMessage({ type: "inject-readout", readout });

    onResult(`Injected readout for ${preview.runnerName} (card ${preview.cardNo}) — ${preview.punches.length} punches`);
  };

  const handleInjectUnknown = () => {
    const cardNo = parseInt(customCardNo, 10);
    if (!cardNo || cardNo <= 0 || !nameId) return;

    const jsDay = new Date().getDay();
    const todaySIDow = jsDay === 0 ? 7 : jsDay;

    const readout: SICardReadout = {
      cardNumber: cardNo,
      cardType: getCardType(cardNo),
      checkTime: null,
      startTime: null,
      finishTime: null,
      clearTime: null,
      finishDayOfWeek: null,
      checkDayOfWeek: todaySIDow,
      punches: [],
      punchCount: 0,
      ownerData: null,
      batteryVoltage: null,
      metadata: null,
    };

    if (!channelRef.current) {
      channelRef.current = new BroadcastChannel(`oxygen-testlab-${nameId}`);
    }
    channelRef.current.postMessage({ type: "inject-readout", readout });

    onResult(`Injected unknown card ${cardNo} — should trigger registration`);
    setCustomCardNo("");
  };

  // Punch editing helpers
  const updatePunch = (idx: number, field: keyof EditablePunch, value: number) => {
    if (!preview) return;
    setPreview({
      ...preview,
      punches: preview.punches.map((p, i) =>
        i === idx ? { ...p, [field]: value } : p,
      ),
    });
  };

  const deletePunch = (idx: number) => {
    if (!preview) return;
    setPreview({
      ...preview,
      punches: preview.punches.filter((_, i) => i !== idx),
    });
  };

  const addPunch = () => {
    if (!preview) return;
    const lastTime = preview.punches.length > 0
      ? preview.punches[preview.punches.length - 1].time + 60
      : (preview.startTime || 32400) + 120;
    setPreview({
      ...preview,
      punches: [...preview.punches, { controlCode: 31, time: lastTime }],
    });
  };

  return (
    <div className="space-y-4 pb-52">
      {/* Runner search */}
      <div className="relative">
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search runner (name, card, bib)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>

        {/* Runner dropdown */}
        {runnerList.data && runnerList.data.length > 0 && !selectedRunnerId && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg max-h-48 overflow-y-auto shadow-lg">
            {runnerList.data.slice(0, 20).map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setSelectedRunnerId(r.id);
                  setSearch(`${r.name} (${r.cardNo})`);
                  setPreview(null);
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-amber-50 border-b border-slate-100 last:border-0 cursor-pointer"
              >
                <span className="font-medium">{r.name}</span>
                <span className="text-slate-400 ml-2">{r.className}</span>
                <span className="text-slate-400 ml-2">SI {r.cardNo}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Custom card injection for unregistered cards */}
      {!selectedRunnerId && !preview && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs text-slate-400">or</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>
      )}
      {!selectedRunnerId && !preview && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            placeholder="Card number (not in competition)"
            value={customCardNo}
            onChange={(e) => setCustomCardNo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInjectUnknown()}
            className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
          <button
            onClick={handleInjectUnknown}
            disabled={!customCardNo || parseInt(customCardNo, 10) <= 0 || !nameId}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
          >
            Inject Unknown Card
          </button>
        </div>
      )}

      {/* Selected runner + action buttons */}
      {selectedRunnerId && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button onClick={() => { setSelectedRunnerId(null); setSearch(""); setPreview(null); }}
              className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer">Clear</button>
          </div>

          <div className="flex items-center gap-2">
            {(["ok", "mp", "dnf", "dns"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => handleGenerate(mode)}
                disabled={generateReadout.isPending}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${
                  mode === "ok" ? "bg-green-600 text-white hover:bg-green-700"
                    : mode === "mp" ? "bg-orange-600 text-white hover:bg-orange-700"
                    : mode === "dnf" ? "bg-red-600 text-white hover:bg-red-700"
                    : "bg-slate-600 text-white hover:bg-slate-700"
                }`}
              >
                {generateReadout.isPending ? "..." : mode.toUpperCase()}
              </button>
            ))}
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
        </div>
      )}

      {/* Preview + editable punch table */}
      {preview && (
        <div className="space-y-4">
          {/* Runner info header */}
          <div className="bg-slate-50 rounded-lg p-3 text-sm">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span><strong>{preview.runnerName}</strong></span>
              <span className="text-slate-500">{preview.className}</span>
              <span className="text-slate-500">{preview.courseName} ({(preview.courseLength / 1000).toFixed(1)} km, {preview.controlCount} controls)</span>
              <span className="text-slate-500">Card: {preview.cardNo}</span>
            </div>
          </div>

          {/* Special times */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <TimeInput label="Check" value={preview.checkTime} onChange={(v) => setPreview({ ...preview, checkTime: v })} />
            <TimeInput label="Clear" value={preview.clearTime} onChange={(v) => setPreview({ ...preview, clearTime: v })} />
            <TimeInput label="Start" value={preview.startTime} onChange={(v) => setPreview({ ...preview, startTime: v })} />
            <TimeInput label="Finish" value={preview.finishTime ?? 0} onChange={(v) => setPreview({ ...preview, finishTime: v > 0 ? v : null })} />
            <div>
              <label className="text-xs text-slate-500 block mb-1">DOW (1-7)</label>
              <input
                type="number"
                min={1}
                max={7}
                value={preview.dayOfWeek}
                onChange={(e) => setPreview({ ...preview, dayOfWeek: Math.max(1, Math.min(7, parseInt(e.target.value) || 1)) })}
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
          </div>

          {/* Punch table */}
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-3 py-2 text-xs text-slate-500 font-medium w-10">#</th>
                  <th className="text-left px-3 py-2 text-xs text-slate-500 font-medium">Control</th>
                  <th className="text-left px-3 py-2 text-xs text-slate-500 font-medium">Time</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {preview.punches.map((punch, idx) => (
                  <tr key={idx} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 text-slate-400">{idx + 1}</td>
                    <td className="px-3 py-1.5">
                      <input
                        type="number"
                        value={punch.controlCode}
                        onChange={(e) => updatePunch(idx, "controlCode", parseInt(e.target.value) || 0)}
                        className="w-20 px-2 py-1 border border-slate-200 rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <TimeInput
                        value={punch.time}
                        onChange={(v) => updatePunch(idx, "time", v)}
                        compact
                      />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <button
                        onClick={() => deletePunch(idx)}
                        className="text-red-400 hover:text-red-600 text-xs cursor-pointer"
                        title="Delete punch"
                      >
                        &#x2715;
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-3 py-2 bg-slate-50 border-t border-slate-200">
              <button
                onClick={addPunch}
                className="text-xs text-amber-600 hover:text-amber-800 font-medium cursor-pointer"
              >
                + Add punch
              </button>
            </div>
          </div>

          {/* Inject button */}
          <button
            onClick={handleInject}
            disabled={!nameId}
            className="px-6 py-2.5 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            Inject Readout
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Time Input ───────────────────────────────────────────────

function TimeInput({
  label,
  value,
  onChange,
  compact,
}: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const handleStart = () => {
    setText(fmtSec(value));
    setEditing(true);
  };

  const handleCommit = () => {
    const parsed = parseSec(text);
    if (parsed !== null) onChange(parsed);
    setEditing(false);
  };

  if (compact) {
    return editing ? (
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleCommit}
        onKeyDown={(e) => e.key === "Enter" && handleCommit()}
        className="w-24 px-2 py-1 border border-amber-300 rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
        autoFocus
      />
    ) : (
      <button
        onClick={handleStart}
        className="w-24 px-2 py-1 text-sm font-mono text-left hover:bg-amber-50 rounded cursor-pointer"
      >
        {fmtSec(value)}
      </button>
    );
  }

  return (
    <div>
      {label && <label className="text-xs text-slate-500 block mb-1">{label}</label>}
      {editing ? (
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={(e) => e.key === "Enter" && handleCommit()}
          className="w-full px-2 py-1.5 border border-amber-300 rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
          autoFocus
        />
      ) : (
        <button
          onClick={handleStart}
          className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono text-left hover:bg-amber-50 cursor-pointer"
        >
          {fmtSec(value)}
        </button>
      )}
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
  const { t } = useTranslation("common");
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
                {expanded ? t("less") : t("more")}
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
  const { t } = useTranslation("common");
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const elapsedSec = Math.round(elapsedMs / 1000);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {processed} / {total} {t("readouts")} ({pct}%)
        </span>
        <span>
          {running ? t("running") : t("finished")} &mdash; {elapsedSec}s {t("elapsed")}
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
