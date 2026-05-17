import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Registration trends — simplified during the post-MeOS migration.
 * Shows the per-event registration curve from the local DB. The full
 * Eventor comparison picker + class breakdown are being re-ported.
 */
export function RegistrationTrendsPage() {
  const { t } = useTranslation("trends");
  void t;
  const timeline = trpc.registrationTrends.ownTimeline.useQuery();

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Registration trends</h1>
      <p className="text-sm text-amber-700 dark:text-amber-300">
        The Eventor comparison picker is being re-ported. The local
        registration curve below stays available.
      </p>

      {timeline.isLoading && <div>Loading…</div>}
      {timeline.error && (
        <div className="text-red-600">
          Failed to load timeline: {timeline.error.message}
        </div>
      )}
      {timeline.data && timeline.data.length === 0 && (
        <div className="text-sm text-slate-500">
          No registrations yet for this event.
        </div>
      )}
      {timeline.data && timeline.data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-2 py-1">Day</th>
              <th className="px-2 py-1">Cumulative entries</th>
            </tr>
          </thead>
          <tbody>
            {timeline.data.map((d) => (
              <tr key={d.day} className="border-b">
                <td className="px-2 py-1 font-mono">{d.day}</td>
                <td className="px-2 py-1">{d.cumulative}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default RegistrationTrendsPage;
