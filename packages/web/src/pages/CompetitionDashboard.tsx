import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Event dashboard — simplified during the post-MeOS migration. Shows
 * core counts + status breakdown; the in-forest progress bar +
 * registration-trends timeline are being re-ported alongside the
 * punch-matcher + eventor sync pipelines.
 */
export function CompetitionDashboard() {
  const { t } = useTranslation("dashboard");
  void t;
  const dashboard = trpc.competition.dashboard.useQuery();

  if (dashboard.isLoading) return <div className="p-6">Loading…</div>;
  if (dashboard.error)
    return (
      <div className="p-6 text-red-600">
        Failed to load dashboard: {dashboard.error.message}
      </div>
    );
  const d = dashboard.data;
  if (!d) return null;

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{d.event.name}</h1>
        {d.event.annotation && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {d.event.annotation}
          </p>
        )}
      </header>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
        <Stat label="Runners" value={d.totalRunners} />
        <Stat label="Clubs" value={d.totalClubs} />
        <Stat label="Classes" value={d.classes.length} />
        <Stat label="Courses" value={d.totalCourses} />
        <Stat label="Controls" value={d.totalControls} />
      </section>

      <section className="rounded-lg border bg-white p-4 shadow dark:bg-slate-800">
        <h2 className="mb-2 text-lg font-semibold">Status breakdown</h2>
        <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <li>
            <span className="text-slate-500">Not started:</span>{" "}
            {d.statusCounts.notStarted}
          </li>
          <li>
            <span className="text-slate-500">In forest:</span>{" "}
            {d.statusCounts.inForest}
          </li>
          <li>
            <span className="text-slate-500">Finished:</span>{" "}
            {d.statusCounts.finished}
          </li>
          <li>
            <span className="text-slate-500">Cancelled:</span>{" "}
            {d.statusCounts.cancelled}
          </li>
          <li>
            <span className="text-slate-500">Start list:</span>{" "}
            {d.statusCounts.startListCount}
          </li>
          <li>
            <span className="text-slate-500">Results:</span>{" "}
            {d.statusCounts.resultCount}
          </li>
        </ul>
      </section>

      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
        Live progress bar (passed-controls completion), registration
        trends timeline, and the dashboard map preview are being
        re-ported against the new PostgreSQL schema.
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-white p-3 shadow-sm dark:bg-slate-800">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

export default CompetitionDashboard;
