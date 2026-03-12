import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { MapPanel } from "../components/MapPanel";
import { SearchableSelect, type SelectOption } from "../components/SearchableSelect";

function CompetitionProgressBar({ courseId }: { courseId?: number }) {
  const { t } = useTranslation("dashboard");
  const completion = trpc.course.controlCompletionStatus.useQuery(
    courseId ? { courseId } : undefined,
    {
      refetchInterval: 15_000,
    }
  );

  if (!completion.data || completion.data.length === 0) return null;

  const totalExpected = completion.data.reduce((s, c) => s + c.total, 0);
  const totalPassed = completion.data.reduce((s, c) => s + c.passed, 0);
  if (totalExpected === 0) return null;

  const pct = Math.min(totalPassed / totalExpected, 1);
  const pctDisplay = Math.round(pct * 100);
  const isComplete = pct >= 1;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            {t("competitionProgress")}
          </span>
          {isComplete && (
            <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              {t("complete")}
            </span>
          )}
        </div>
        <div className="text-sm text-slate-600">
          <span className="font-bold text-slate-900">{totalPassed.toLocaleString()}</span>
          <span className="text-slate-400"> / </span>
          <span>{totalExpected.toLocaleString()}</span>
          <span className="text-slate-400 ml-1">{t("controlPunches")}</span>
        </div>
      </div>
      <div className="relative w-full h-3 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${isComplete
            ? "bg-emerald-500"
            : pct > 0.75
              ? "bg-gradient-to-r from-emerald-400 to-emerald-500"
              : pct > 0.4
                ? "bg-gradient-to-r from-blue-400 to-blue-500"
                : "bg-gradient-to-r from-amber-400 to-amber-500"
            }`}
          style={{ width: `${pctDisplay}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <span className={`text-lg font-black ${isComplete ? "text-emerald-600" : "text-slate-800"}`}>
          {pctDisplay}%
        </span>
        <span className="text-xs text-slate-400">
          {t("controlsCount", { count: completion.data.length })}
        </span>
      </div>
    </div>
  );
}

export function CompetitionDashboard() {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const dashboard = trpc.competition.dashboard.useQuery();
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);
  const [showCompletion, setShowCompletion] = useState(false);

  // Build class options for the searchable select
  const classOptions: SelectOption[] = useMemo(() => {
    if (!dashboard.data) return [];
    return dashboard.data.classes.map((cls) => ({
      value: cls.id,
      label: cls.name,
      suffix: t("runnersCount", { count: cls.runnerCount }),
    }));
  }, [dashboard.data]);

  // Find the course name(s) and courseId for the selected class
  const selectedClassCourseNames: string[] = useMemo(() => {
    if (!selectedClassId || !dashboard.data) return [];
    const cls = dashboard.data.classes.find((c) => c.id === selectedClassId);
    if (!cls || !cls.courseId) return [];
    const course = dashboard.data.courses.find((c) => c.id === cls.courseId);
    return course ? [course.name] : [];
  }, [selectedClassId, dashboard.data]);

  const selectedCourseId: number | undefined = useMemo(() => {
    if (!selectedClassId || !dashboard.data) return undefined;
    const cls = dashboard.data.classes.find((c) => c.id === selectedClassId);
    return cls?.courseId ?? undefined;
  }, [selectedClassId, dashboard.data]);

  if (dashboard.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!dashboard.data) return null;

  const d = dashboard.data;
  const sc = d.statusCounts;

  return (
    <>
      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-4">
        <StatCard label={t("runners")} value={d.totalRunners} onClick={() => navigate("runners")} />
        <StatCard label={t("clubs")} value={d.totalClubs} onClick={() => navigate("clubs")} />
        <StatCard label={t("classes")} value={d.classes.length} onClick={() => navigate("classes")} />
        <StatCard label={t("courses")} value={d.totalCourses} onClick={() => navigate("courses")} />
        <StatCard label={t("controls")} value={d.totalControls} onClick={() => navigate("controls")} />
      </div>

      {/* Race Status Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatusCard
          label={t("notYetStarted")}
          description={t("stillWaiting")}
          value={sc.notStarted}
          color="slate"
          onClick={() => navigate("runners?q=status:not-started")}
        />
        <StatusCard
          label={t("inTheForest")}
          description={t("awaitingFinish")}
          value={sc.inForest}
          color="amber"
          onClick={() => navigate("runners?q=status:in-forest")}
        />
        <StatusCard
          label={t("finished")}
          description={t("resultBooked")}
          value={sc.finished}
          color="emerald"
          onClick={() => navigate("results?status=finished")}
        />
      </div>

      {/* Competition progress */}
      <CompetitionProgressBar courseId={selectedCourseId} />

      {/* Map with class filter */}
      <MapPanel
        className="w-full"
        height="700px"
        fitToControls
        highlightCourseNames={selectedClassCourseNames.length > 0 ? selectedClassCourseNames : undefined}
        onControlClick={(id) => navigate(`controls?control=${id}`)}
        showCompletion={showCompletion}
        onCompletionToggle={setShowCompletion}
        completionCourseId={selectedCourseId}
        toolbar={
          <>
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              {t("map")}
            </h2>
            <div className="w-64">
              <SearchableSelect
                value={selectedClassId ?? ""}
                onChange={(v) => setSelectedClassId(v ? Number(v) : null)}
                options={[{ value: "", label: t("allClasses") }, ...classOptions]}
                placeholder={t("filterByClass")}
                searchPlaceholder={t("searchClass")}
                className="text-sm"
              />
            </div>
          </>
        }
      />
    </>
  );
}

function StatCard({
  label,
  value,
  accent,
  onClick,
}: {
  label: string;
  value: number;
  accent?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`bg-white rounded-xl border border-slate-200 p-4 text-left ${onClick ? "hover:bg-blue-50 hover:border-blue-200 transition-colors cursor-pointer" : ""}`}
    >
      <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">
        {label}
      </div>
      <div className={`text-2xl font-bold mt-1 ${accent ? "text-emerald-600" : "text-slate-900"}`}>
        {value}
      </div>
    </Tag>
  );
}

const statusColorMap: Record<string, { bg: string; border: string; text: string; valueText: string; hoverBg: string }> = {
  slate: {
    bg: "bg-slate-50",
    border: "border-slate-200",
    text: "text-slate-600",
    valueText: "text-slate-900",
    hoverBg: "hover:bg-slate-100",
  },
  amber: {
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-700",
    valueText: "text-amber-900",
    hoverBg: "hover:bg-amber-100",
  },
  emerald: {
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    text: "text-emerald-700",
    valueText: "text-emerald-900",
    hoverBg: "hover:bg-emerald-100",
  },
};

function StatusCard({
  label,
  description,
  value,
  color,
  onClick,
}: {
  label: string;
  description: string;
  value: number;
  color: "slate" | "amber" | "emerald";
  onClick: () => void;
}) {
  const c = statusColorMap[color];
  return (
    <button
      onClick={onClick}
      className={`${c.bg} ${c.hoverBg} rounded-xl border ${c.border} p-4 text-left transition-colors cursor-pointer group`}
    >
      <div className="flex items-center justify-between mb-1">
        <div className={`text-xs font-semibold uppercase tracking-wider ${c.text}`}>
          {label}
        </div>
        <svg
          className={`w-4 h-4 ${c.text} opacity-0 group-hover:opacity-100 transition-opacity`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
      <div data-testid="status-value" className={`text-3xl font-black ${c.valueText}`}>
        {value}
      </div>
      <div className={`text-xs mt-1 ${c.text} opacity-75`}>
        {description}
      </div>
    </button>
  );
}
