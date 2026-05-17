import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Cards page — simplified during the post-MeOS migration. Shows the
 * basic card roster derived from the new schema. The full detail panel
 * (per-card readout history, manual link-to-runner, time editing) is
 * being re-ported alongside the punch-matcher pipeline.
 */
export function CardsPage() {
  const { t } = useTranslation("common");
  void t;
  const cards = trpc.cardReadout.cardList.useQuery();

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Cards</h1>
      <p className="mb-4 text-sm text-amber-700 dark:text-amber-300">
        Detailed card management (link to runner, edit punches, view
        readout history) is being re-ported against the new PostgreSQL
        schema. The card roster below stays available.
      </p>

      {cards.isLoading && <div>Loading…</div>}
      {cards.error && (
        <div className="text-red-600">Failed to load cards: {cards.error.message}</div>
      )}
      {cards.data && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-2 py-1">Card</th>
              <th className="px-2 py-1">Voltage (mV)</th>
              <th className="px-2 py-1">Reads</th>
              <th className="px-2 py-1">Runner</th>
              <th className="px-2 py-1">Class</th>
              <th className="px-2 py-1">Club</th>
            </tr>
          </thead>
          <tbody>
            {cards.data.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="px-2 py-1 font-mono">{c.cardNo}</td>
                <td className="px-2 py-1">{c.voltageMv || "—"}</td>
                <td className="px-2 py-1">{c.readCount}</td>
                <td className="px-2 py-1">{c.runnerName || <em className="text-gray-400">unassigned</em>}</td>
                <td className="px-2 py-1">{c.className}</td>
                <td className="px-2 py-1">{c.clubName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default CardsPage;
